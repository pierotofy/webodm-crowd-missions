import json
import os
import re
import shutil
from contextlib import closing

from django.db.models import Q
from django.http import FileResponse, HttpResponse
from django.utils.translation import gettext as _
from django.contrib.auth.models import Group, User
from guardian.shortcuts import assign_perm, get_groups_with_perms, get_objects_for_user, get_users_with_perms, remove_perm
from PIL import Image, ImageOps
from rest_framework import exceptions, permissions
from rest_framework.response import Response
from rest_framework.views import APIView

from app.models import Preset, Project, Task
from nodeodm.models import ProcessingNode
from worker import tasks as worker_tasks
from . import db, geo

IMAGE_EXT = (".jpg", ".jpeg", ".tif", ".tiff", ".png", ".dng")
TASK_STATUS = {None: "Waiting", 10: "Queued", 20: "Running", 30: "Stopped with a problem", 40: "Completed", 50: "Canceled"}


def problem(msg, code=400):
    return Response({"detail": msg}, status=code)


def load_mission(c, request, mid, manage=False):
    m = c.execute("SELECT * FROM missions WHERE id=?", (mid,)).fetchone()
    if m is None:
        raise exceptions.NotFound()
    project = Project.objects.filter(pk=m["project_id"], deleting=False).first()
    if project is None or not request.user.has_perm("view_project", project):
        raise exceptions.NotFound()
    can_manage = request.user.has_perm("change_project", project)
    if manage and not can_manage:
        raise exceptions.PermissionDenied(_("Only people who can edit project \"%(project)s\" can do this.") % {"project": project.name})
    return m, project, can_manage


def load_cell(c, mid, cid):
    cell = c.execute("SELECT * FROM cells WHERE id=? AND mission_id=?", (cid, mid)).fetchone()
    if cell is None:
        raise exceptions.NotFound()
    return cell


def thumb_path(mid, filename):
    return os.path.join(db.mission_dir(mid), "thumbs", filename + ".jpg")


def delete_images(c, mid, where, args):
    d = db.mission_dir(mid)
    for r in c.execute("SELECT filename FROM images WHERE mission_id=? AND " + where, (mid,) + args).fetchall():
        for f in (os.path.join(d, r["filename"]), thumb_path(mid, r["filename"])):
            try:
                os.remove(f)
            except FileNotFoundError:
                pass
    c.execute("DELETE FROM images WHERE mission_id=? AND " + where, (mid,) + args)


def clean_params(p):
    try:
        out = {
            "drone": str(p.get("drone")),
            "altitude": float(p.get("altitude")),
            "front": float(p.get("front")),
            "side": float(p.get("side")),
            "angle": float(p.get("angle")) % 360,
        }
    except (TypeError, ValueError):
        raise exceptions.ValidationError(_("Fill in every flight setting."))
    if out["drone"] not in geo.PRESETS:
        raise exceptions.ValidationError(_("Choose a drone from the list."))
    if not 10 <= out["altitude"] <= 500:
        raise exceptions.ValidationError(_("Altitude must be between 10 and 500 meters."))
    if not (50 <= out["front"] <= 95 and 50 <= out["side"] <= 95):
        raise exceptions.ValidationError(_("Overlap must be between 50% and 95%."))
    return out


def clean_cell_size(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        v = 0
    if not 50 <= v <= 2000:
        raise exceptions.ValidationError(_("Cell size must be between 50 and 2000 meters."))
    return v


def read_gps(path):
    try:
        with Image.open(path) as im:
            gps = im.getexif().get_ifd(0x8825)

        def deg(v):
            return float(v[0]) + float(v[1]) / 60.0 + float(v[2]) / 3600.0

        lat, lon = deg(gps[2]), deg(gps[4])
        if gps.get(1) == "S":
            lat = -lat
        if gps.get(3) == "W":
            lon = -lon
        return round(lat, 7), round(lon, 7)
    except Exception:
        return None, None


def slug(s):
    return re.sub(r"[^\w\-]+", "_", s).strip("_")[:60] or "mission"


def user_missions(user):
    with closing(db.connect()) as c:
        rows = c.execute("SELECT m.id, m.name, m.project_id, m.created_at, m.open, COUNT(c.id) AS total, "
                         "COALESCE(SUM(c.status='approved'), 0) AS approved, COALESCE(SUM(c.pilot_id=?), 0) AS mine "
                         "FROM missions m LEFT JOIN cells c ON c.mission_id=m.id GROUP BY m.id ORDER BY m.id DESC",
                         (user.id,)).fetchall()
    projects = {p.id: p for p in Project.objects.filter(id__in=set(r["project_id"] for r in rows), deleting=False)}
    mine, joinable = [], []
    for r in rows:
        p = projects.get(r["project_id"])
        if p is None:
            continue
        item = dict(r, project=p.name, percent=int(100 * r["approved"] / r["total"]) if r["total"] else 0)
        if user.has_perm("view_project", p):
            mine.append(item)
        elif r["open"]:
            joinable.append(item)
    return mine, joinable


def editable_projects(user):
    return get_objects_for_user(user, "app.change_project", Project.objects.filter(deleting=False), accept_global_perms=False).order_by("-created_at")


MANAGER_PERMS = ("add_project", "change_project", "delete_project", "view_project")
ROLE_PERMS = {"manager": MANAGER_PERMS, "pilot": ("view_project",), "none": ()}


def role_of(perms):
    return "manager" if "change_project" in perms else ("pilot" if "view_project" in perms else None)


def access_list(project):
    out = [{"kind": "user", "name": project.owner.username, "role": "manager", "owner": True}]
    for u, perms in get_users_with_perms(project, attach_perms=True, with_group_users=False).items():
        r = role_of(perms)
        if r and u != project.owner:
            out.append({"kind": "user", "name": u.username, "role": r, "owner": False})
    for g, perms in get_groups_with_perms(project, attach_perms=True).items():
        r = role_of(perms)
        if r:
            out.append({"kind": "group", "name": g.name, "role": r, "owner": False})
    out[1:] = sorted(out[1:], key=lambda e: (e["role"] != "manager", e["kind"], e["name"].lower()))
    return out


def find_target(kind, name):
    name = str(name or "").strip()
    if kind == "group":
        t = Group.objects.filter(name=name).first()
        if t is None:
            raise exceptions.ValidationError(_("No group named \"%(name)s\" exists. Check the name and try again.") % {"name": name})
    else:
        t = User.objects.filter(username=name).first()
        if t is None:
            raise exceptions.ValidationError(_("No user named \"%(name)s\" exists. Check the name and try again.") % {"name": name})
    return t


def apply_role(project, target, role):
    if isinstance(target, User) and target == project.owner:
        return
    wanted = ROLE_PERMS[role]
    for p in MANAGER_PERMS:
        if p in wanted:
            assign_perm(p, target, project)
        else:
            remove_perm(p, target, project)


def release_lost_cells(project):
    with closing(db.connect()) as c:
        rows = c.execute("SELECT c.id, c.mission_id, c.pilot_id FROM cells c JOIN missions m ON m.id=c.mission_id "
                         "WHERE m.project_id=? AND c.status IN ('claimed','reflight') AND c.pilot_id IS NOT NULL", (project.id,)).fetchall()
        users = {u.id: u for u in User.objects.filter(id__in=set(r["pilot_id"] for r in rows))}
        for r in rows:
            u = users.get(r["pilot_id"])
            if u is None or not u.has_perm("view_project", project):
                c.execute("BEGIN IMMEDIATE")
                delete_images(c, r["mission_id"], "cell_id=?", (r["id"],))
                c.execute("UPDATE cells SET status='available', pilot_id=NULL, pilot_name=NULL, note='', updated_at=CURRENT_TIMESTAMP WHERE id=?", (r["id"],))
                c.execute("COMMIT")


class ProjectAccess(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, pid):
        project = Project.objects.filter(pk=pid, deleting=False).first()
        if project is None or not request.user.has_perm("change_project", project):
            raise exceptions.NotFound()
        return Response({"entries": access_list(project)})


class Groups(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request):
        q = str(request.query_params.get("search") or "")
        return Response([g.name for g in Group.objects.filter(name__istartswith=q).order_by("name")[:10]])


class Access(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
        return Response({"entries": access_list(project), "open": bool(m["open"]), "project": project.name,
                         "can_manage": can_manage, "me": request.user.username})

    def post(self, request, mid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid, manage=True)
            if "open" in request.data:
                c.execute("UPDATE missions SET open=? WHERE id=?", (1 if request.data.get("open") else 0, mid))
        if request.data.get("name"):
            role = request.data.get("role")
            if role not in ROLE_PERMS:
                return problem(_("Choose Pilot or Manager."))
            target = find_target(request.data.get("kind"), request.data.get("name"))
            if isinstance(target, User) and target == project.owner:
                return problem(_("%(name)s owns this project and always has full access.") % {"name": target.username})
            apply_role(project, target, role)
            release_lost_cells(project)
        if not request.user.has_perm("view_project", project):
            return Response({"entries": [], "open": False, "project": project.name, "can_manage": False, "me": request.user.username, "left": True})
        return self.get(request, mid)


class Join(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request, mid):
        with closing(db.connect()) as c:
            m = c.execute("SELECT * FROM missions WHERE id=?", (mid,)).fetchone()
        project = Project.objects.filter(pk=m["project_id"], deleting=False).first() if m else None
        if project is None or not (m["open"] or request.user.has_perm("view_project", project)):
            raise exceptions.NotFound()
        if not request.user.has_perm("view_project", project):
            assign_perm("view_project", request.user, project)
        return Response({"id": m["id"]})


class Grid(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request):
        size = clean_cell_size(request.data.get("cell_size"))
        try:
            cells, total = geo.split(request.data.get("aoi") or {}, size)
        except (ValueError, KeyError, TypeError, IndexError) as e:
            return problem(str(e) if isinstance(e, ValueError) else _("The area could not be read. Draw it again or import a different file."))
        return Response({"cells": cells, "area": total})


class Missions(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request):
        name = str(request.data.get("name") or "").strip()[:255]
        if not name:
            return problem(_("Type a name for the mission."))
        pid = request.data.get("project")
        if pid == "new":
            if not request.user.has_perm("app.add_project"):
                return problem(_("Your account cannot create projects. Choose an existing project."), 403)
            project = None
        else:
            project = Project.objects.filter(pk=pid, deleting=False).first() if str(pid).isdigit() else None
            if project is None or not request.user.has_perm("change_project", project):
                return problem(_("Choose a project you can edit."))
        size = clean_cell_size(request.data.get("cell_size"))
        params = clean_params(request.data.get("params") or {})
        targets = None
        if request.data.get("access") is not None:
            targets = []
            for e in request.data.get("access"):
                if e.get("role") not in ("pilot", "manager"):
                    return problem(_("Choose Pilot or Manager for every person."))
                targets.append((find_target(e.get("kind"), e.get("name")), e.get("role")))
        aoi = request.data.get("aoi")
        try:
            cells, _area = geo.split(aoi or {}, size)
        except (ValueError, KeyError, TypeError, IndexError) as e:
            return problem(str(e) if isinstance(e, ValueError) else _("Draw or import the area to map."))
        if not cells:
            return problem(_("The area is smaller than one cell. Choose a smaller cell size."))
        if project is None:
            project = Project.objects.create(owner=request.user, name=name)
        if targets is not None:
            keep = set()
            for t, r in targets:
                apply_role(project, t, r)
                keep.add((type(t).__name__, t.pk))
            for u in get_users_with_perms(project, with_group_users=False):
                if ("User", u.pk) not in keep:
                    apply_role(project, u, "none")
            for g in get_groups_with_perms(project):
                if ("Group", g.pk) not in keep:
                    apply_role(project, g, "none")
            release_lost_cells(project)

        with closing(db.connect()) as c:
            c.execute("BEGIN IMMEDIATE")
            cur = c.execute("INSERT INTO missions(project_id, name, aoi, cell_size, params, created_by, open) VALUES(?,?,?,?,?,?,?)",
                            (project.id, name, json.dumps(aoi), size, json.dumps(params), request.user.id, 1 if request.data.get("open") else 0))
            mid = cur.lastrowid
            c.executemany("INSERT INTO cells(mission_id, idx, geom) VALUES(?,?,?)",
                          [(mid, i + 1, json.dumps(g)) for i, g in enumerate(cells)])
            c.execute("COMMIT")
        return Response({"id": mid}, status=201)


class Mission(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
            cells = c.execute("SELECT c.*, COUNT(i.id) AS images, COALESCE(SUM(i.size), 0) AS bytes FROM cells c "
                              "LEFT JOIN images i ON i.cell_id=c.id WHERE c.mission_id=? GROUP BY c.id ORDER BY c.idx", (mid,)).fetchall()
        params = json.loads(m["params"])
        preset, alt, line_sp, photo_sp, gsd, speed = geo.camera(params)
        task_ids = json.loads(m["tasks"])
        tasks = {str(t.id): t for t in Task.objects.filter(id__in=task_ids, project=project)}
        out_tasks = []
        for tid in reversed(task_ids):
            t = tasks.get(tid)
            if t is None:
                continue
            out_tasks.append({"id": tid, "created_at": t.created_at.isoformat(), "images": t.images_count,
                              "status": t.status, "status_label": TASK_STATUS.get(t.status, ""),
                              "progress": round(t.running_progress * 100) if t.status == 20 else None,
                              "map_url": "/map/project/%s/task/%s/" % (project.id, tid),
                              "dashboard_url": "/dashboard/?project_task_open=%s&project_task_expanded=%s" % (project.id, tid)})
        return Response({
            "id": m["id"], "name": m["name"], "created_at": m["created_at"],
            "project": {"id": project.id, "name": project.name},
            "aoi": json.loads(m["aoi"]), "cell_size": m["cell_size"], "params": params,
            "drone": preset["label"], "gsd": round(gsd, 3), "speed": speed,
            "formats": (["kmz"] if "dji" in preset else []) + ["csv", "plan", "kml", "geojson"],
            "can_manage": can_manage, "user_id": request.user.id,
            "cells": [{"id": r["id"], "idx": r["idx"], "geom": json.loads(r["geom"]), "status": r["status"],
                       "pilot_id": r["pilot_id"], "pilot_name": r["pilot_name"], "note": r["note"],
                       "images": r["images"], "bytes": r["bytes"], "updated_at": r["updated_at"]} for r in cells],
            "tasks": out_tasks,
        })

    def patch(self, request, mid):
        params = clean_params(request.data.get("params") or {})
        with closing(db.connect()) as c:
            load_mission(c, request, mid, manage=True)
            c.execute("UPDATE missions SET params=? WHERE id=?", (json.dumps(params), mid))
        return Response({"success": True})

    def delete(self, request, mid):
        with closing(db.connect()) as c:
            load_mission(c, request, mid, manage=True)
            c.execute("BEGIN IMMEDIATE")
            c.execute("DELETE FROM images WHERE mission_id=?", (mid,))
            c.execute("DELETE FROM cells WHERE mission_id=?", (mid,))
            c.execute("DELETE FROM missions WHERE id=?", (mid,))
            c.execute("COMMIT")
        shutil.rmtree(db.mission_dir(mid), ignore_errors=True)
        return Response({"success": True})


class CellAction(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request, mid, cid, action):
        uid = request.user.id
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
            cell = load_cell(c, mid, cid)
            mine = cell["pilot_id"] == uid
            c.execute("BEGIN IMMEDIATE")
            if action == "claim":
                cur = c.execute("UPDATE cells SET status='claimed', pilot_id=?, pilot_name=?, note='', updated_at=CURRENT_TIMESTAMP "
                                "WHERE id=? AND status='available'", (uid, request.user.username, cid))
                if cur.rowcount == 0:
                    c.execute("ROLLBACK")
                    return problem(_("Cell %(cell)s was just claimed by someone else.") % {"cell": cell["idx"]}, 409)
            elif action == "release":
                if not ((mine and cell["status"] in ("claimed", "reflight")) or (can_manage and cell["status"] != "available")):
                    c.execute("ROLLBACK")
                    raise exceptions.PermissionDenied()
                delete_images(c, mid, "cell_id=?", (cid,))
                c.execute("UPDATE cells SET status='available', pilot_id=NULL, pilot_name=NULL, note='', updated_at=CURRENT_TIMESTAMP WHERE id=?", (cid,))
            elif action == "submit":
                if not (mine and cell["status"] in ("claimed", "reflight")):
                    c.execute("ROLLBACK")
                    raise exceptions.PermissionDenied()
                if c.execute("SELECT COUNT(*) FROM images WHERE cell_id=?", (cid,)).fetchone()[0] == 0:
                    c.execute("ROLLBACK")
                    return problem(_("Upload images before submitting.") % {"cell": cell["idx"]})
                c.execute("UPDATE cells SET status='submitted', note='', updated_at=CURRENT_TIMESTAMP WHERE id=?", (cid,))
            elif action == "approve":
                if not (can_manage and cell["status"] == "submitted"):
                    c.execute("ROLLBACK")
                    raise exceptions.PermissionDenied()
                c.execute("UPDATE cells SET status='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?", (cid,))
            elif action == "reflight":
                if not (can_manage and cell["status"] in ("submitted", "approved")):
                    c.execute("ROLLBACK")
                    raise exceptions.PermissionDenied()
                note = str(request.data.get("note") or "").strip()[:1000]
                delete_images(c, mid, "cell_id=?", (cid,))
                c.execute("UPDATE cells SET status='reflight', note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?", (note, cid))
            else:
                c.execute("ROLLBACK")
                raise exceptions.NotFound()
            c.execute("COMMIT")
        return Response({"success": True})


class CellImages(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid, cid):
        with closing(db.connect()) as c:
            load_mission(c, request, mid)
            load_cell(c, mid, cid)
            rows = c.execute("SELECT id, filename, size, lat, lon FROM images WHERE cell_id=? ORDER BY filename", (cid,)).fetchall()
        return Response([dict(r, filename=r["filename"].split("_", 1)[-1]) for r in rows])

    def post(self, request, mid, cid):
        f = request.FILES.get("file")
        if f is None:
            return problem(_("No file was received. Try uploading again."))
        name = re.sub(r"[^\w.\-]+", "_", os.path.basename(f.name or ""))[-150:]
        if not name.lower().endswith(IMAGE_EXT):
            return problem(_("%(file)s is not an image. Upload JPG, TIFF, PNG or DNG files.") % {"file": f.name})
        with closing(db.connect()) as c:
            load_mission(c, request, mid)
            cell = load_cell(c, mid, cid)
            if cell["pilot_id"] != request.user.id or cell["status"] not in ("claimed", "reflight"):
                return problem(_("Claim this cell before uploading."), 403)
            fname = "%04d_%s" % (cell["idx"], name)
            d = db.mission_dir(mid)
            os.makedirs(d, exist_ok=True)
            dst = os.path.join(d, fname)
            tmp = dst + ".part"
            with open(tmp, "wb") as out:
                for chunk in f.chunks():
                    out.write(chunk)
            os.replace(tmp, dst)
            try:
                os.remove(thumb_path(mid, fname))
            except FileNotFoundError:
                pass
            lat, lon = read_gps(dst)
            c.execute("INSERT OR REPLACE INTO images(mission_id, cell_id, filename, size, lat, lon, user_id) VALUES(?,?,?,?,?,?,?)",
                      (mid, cid, fname, os.path.getsize(dst), lat, lon, request.user.id))
        return Response({"success": True, "lat": lat, "lon": lon})


class CellImage(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def delete(self, request, mid, cid, iid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
            cell = load_cell(c, mid, cid)
            mine = cell["pilot_id"] == request.user.id and cell["status"] in ("claimed", "reflight")
            if not (mine or (can_manage and cell["status"] != "approved")):
                raise exceptions.PermissionDenied()
            delete_images(c, mid, "cell_id=? AND id=?", (cid, iid))
        return Response({"success": True})


def load_image(request, mid, cid, iid):
    with closing(db.connect()) as c:
        load_mission(c, request, mid)
        load_cell(c, mid, cid)
        r = c.execute("SELECT filename FROM images WHERE id=? AND cell_id=? AND mission_id=?", (iid, cid, mid)).fetchone()
    if r is None:
        raise exceptions.NotFound()
    return r["filename"], os.path.join(db.mission_dir(mid), r["filename"])


class CellImageThumb(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid, cid, iid):
        fname, src = load_image(request, mid, cid, iid)
        dst = thumb_path(mid, fname)
        if not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                with Image.open(src) as im:
                    im.draft("RGB", (640, 640))
                    t = ImageOps.exif_transpose(im).convert("RGB")
                t.thumbnail((256, 256))
                tmp = dst + ".%s.part" % os.getpid()
                t.save(tmp, "JPEG", quality=80)
                os.replace(tmp, dst)
            except Exception:
                raise exceptions.NotFound()
        resp = FileResponse(open(dst, "rb"), content_type="image/jpeg")
        resp["Cache-Control"] = "private, max-age=86400"
        return resp


class CellPlan(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid, cid, fmt):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
            cell = load_cell(c, mid, cid)
        geom = json.loads(cell["geom"])
        params = json.loads(m["params"])
        base = "%s_cell%s" % (slug(m["name"]), cell["idx"])
        try:
            if fmt == "geojson":
                body, ctype = geo.export_geojson(geom, cell["idx"]), "application/geo+json"
            elif fmt == "kml":
                body, ctype = geo.export_kml(geom, cell["idx"]), "application/vnd.google-earth.kml+xml"
            else:
                plan = geo.flight_lines(geom, params)
                if not plan["lines"]:
                    return problem(_("This cell is too small for a flight plan."))
                if fmt == "kmz":
                    if "dji" not in plan["preset"]:
                        raise exceptions.NotFound()
                    body, ctype = geo.export_kmz(plan), "application/vnd.google-earth.kmz"
                elif fmt == "csv":
                    body, ctype = geo.export_litchi(plan), "text/csv"
                elif fmt == "plan":
                    body, ctype = geo.export_qgc(plan), "application/json"
                else:
                    raise exceptions.NotFound()
        except ValueError as e:
            return problem(str(e))
        resp = HttpResponse(body, content_type=ctype)
        resp["Content-Disposition"] = 'attachment; filename="%s.%s"' % (base, fmt)
        return resp


def path_payload(plan):
    return {"lines": plan["lines"], "photos": plan["photos"], "length": round(plan["length"]), "speed": plan["speed"]}


class Path(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request):
        params = clean_params(request.data.get("params") or {})
        try:
            plan = geo.flight_lines(request.data.get("geom") or {}, params)
        except (ValueError, KeyError, TypeError, IndexError, ZeroDivisionError):
            return problem(_("Unable to plan this cell."))
        return Response(path_payload(plan))


class CellPath(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def get(self, request, mid, cid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid)
            cell = load_cell(c, mid, cid)
        try:
            plan = geo.flight_lines(json.loads(cell["geom"]), json.loads(m["params"]))
        except (ValueError, KeyError, TypeError, IndexError, ZeroDivisionError):
            return problem(_("Unable to plan this cell."))
        return Response(path_payload(plan))


class Process(APIView):
    permission_classes = (permissions.IsAuthenticated,)

    def post(self, request, mid):
        with closing(db.connect()) as c:
            m, project, can_manage = load_mission(c, request, mid, manage=True)
            rows = c.execute("SELECT i.filename FROM images i JOIN cells c ON c.id=i.cell_id "
                             "WHERE i.mission_id=? AND c.status='approved'", (mid,)).fetchall()
        if len(rows) < 2:
            return problem(_("Approve cells with at least 2 images first."))
        if ProcessingNode.find_best_available_node(project.owner) is None:
            return problem(_("No processing node is available to %(owner)s. Ask an administrator to share one.") % {"owner": project.owner.username})
        options = []
        pid = request.data.get("preset")
        if pid:
            preset = Preset.objects.filter(Q(owner=request.user.id) | Q(system=True), pk=pid).first()
            if preset is None:
                return problem(_("The selected processing preset no longer exists. Choose another preset."))
            options = preset.options

        task = Task.objects.create(project=project, name=m["name"], options=options, partial=True)
        src = db.mission_dir(mid)
        os.makedirs(task.task_path(), exist_ok=True)
        for r in rows:
            dst = task.task_path(r["filename"])
            try:
                os.link(os.path.join(src, r["filename"]), dst)
            except OSError:
                shutil.copyfile(os.path.join(src, r["filename"]), dst)
        task.partial = False
        task.images_count = len(task.scan_images())
        task.update_size()
        task.save()
        worker_tasks.process_task.delay(task.id)

        with closing(db.connect()) as c:
            c.execute("BEGIN IMMEDIATE")
            cur = json.loads(c.execute("SELECT tasks FROM missions WHERE id=?", (mid,)).fetchone()["tasks"])
            cur.append(str(task.id))
            c.execute("UPDATE missions SET tasks=? WHERE id=?", (json.dumps(cur), mid))
            c.execute("COMMIT")
        return Response({"task": str(task.id), "images": task.images_count})
