import json
import os

from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.shortcuts import render
from django.templatetags.static import static
from django.views.decorators.csrf import ensure_csrf_cookie
from django.utils.translation import gettext as _

from app.models import Basemap
from app.plugins import Menu, MountPoint, PluginBase
from . import api, geo


def map_css():
    try:
        with open(os.path.join(settings.BASE_DIR, "webpack-stats.json"), encoding="utf-8") as f:
            chunks = json.load(f)["chunks"]["MapView"]
        return [static("app/bundles/" + c["name"]) for c in chunks if c["name"].endswith(".css")]
    except Exception:
        return []


def asset_version():
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
    try:
        return str(int(max(e.stat().st_mtime for e in os.scandir(d) if e.is_file())))
    except ValueError:
        return "0"


def presets_json():
    return json.dumps({k: {"label": v["label"], "sw": v["sw"], "sh": v["sh"], "f": v["f"], "iw": v["iw"], "max_wp": geo.max_waypoints(v) if "dji" in v else 0}
                       for k, v in geo.PRESETS.items()})


class Plugin(PluginBase):
    def main_menu(self):
        return [Menu(_("Crowd Missions"), self.public_url(""), "fa fa-route fa-fw")]

    def app_mount_points(self):
        @login_required
        @ensure_csrf_cookie
        def missions_view(request):
            mine, joinable = api.user_missions(request.user)
            return render(request, self.template_path("missions.html"), {
                "title": _("Crowd Missions"),
                "plugin_url": self.public_url(""),
                "v": asset_version(),
                "missions": mine,
                "joinable": joinable,
                "can_create": request.user.has_perm("app.add_project") or api.editable_projects(request.user).exists(),
            })

        @login_required
        @ensure_csrf_cookie
        def new_view(request):
            return render(request, self.template_path("new.html"), {
                "title": _("New mission"),
                "map_css": map_css(),
                "plugin_url": self.public_url(""),
                "v": asset_version(),
                "projects": api.editable_projects(request.user),
                "can_add_project": request.user.has_perm("app.add_project"),
                "presets": presets_json(),
                "basemaps": json.dumps(Basemap.get_cached_basemaps()),
            })

        @login_required
        @ensure_csrf_cookie
        def mission_view(request, mid):
            return render(request, self.template_path("mission.html"), {
                "title": _("Mission"),
                "map_css": map_css(),
                "plugin_url": self.public_url(""),
                "v": asset_version(),
                "mission_id": int(mid),
                "presets": presets_json(),
                "basemaps": json.dumps(Basemap.get_cached_basemaps()),
            })

        return [
            MountPoint("$", missions_view),
            MountPoint("new/$", new_view),
            MountPoint(r"(?P<mid>\d+)/$", mission_view),
        ]

    def api_mount_points(self):
        return [
            MountPoint("grid$", api.Grid.as_view()),
            MountPoint("path$", api.Path.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/path$", api.CellPath.as_view()),
            MountPoint("missions$", api.Missions.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)$", api.Mission.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/process$", api.Process.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/access$", api.Access.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/join$", api.Join.as_view()),
            MountPoint(r"projects/(?P<pid>\d+)/access$", api.ProjectAccess.as_view()),
            MountPoint("groups$", api.Groups.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/(?P<action>claim|release|submit|approve|reflight)$", api.CellAction.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/images$", api.CellImages.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/images/(?P<iid>\d+)$", api.CellImage.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/images/(?P<iid>\d+)/thumb$", api.CellImageThumb.as_view()),
            MountPoint(r"missions/(?P<mid>\d+)/cells/(?P<cid>\d+)/plan\.(?P<fmt>kmz|csv|plan|kml|geojson)$", api.CellPlan.as_view()),
        ]
