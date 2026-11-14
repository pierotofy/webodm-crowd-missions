import io
import json
import math
import time
import zipfile
from pyproj import Transformer

MAX_CELLS = 2000
DJI_FLY_MAX_WAYPOINTS = 200
DJI_PILOT_MAX_WAYPOINTS = 65535

PRESETS = {
    "mini4pro": {"label": "DJI Mini 4 Pro", "sw": 9.6, "sh": 7.2, "f": 6.66, "iw": 4032, "dji": [68, 0, 0]},
    "mini5pro": {"label": "DJI Mini 5 Pro", "sw": 12.8, "sh": 9.6, "f": 8.87, "iw": 4032, "dji": [68, 0, 0]},
    "air3": {"label": "DJI Air 3", "sw": 9.6, "sh": 7.2, "f": 6.66, "iw": 4032, "dji": [68, 0, 0]},
    "m3e": {"label": "DJI Mavic 3 Enterprise", "sw": 17.3, "sh": 13.0, "f": 12.29, "iw": 5280, "dji": [77, 0, 66]},
    "air2s": {"label": "DJI Air 2S", "sw": 13.2, "sh": 8.8, "f": 8.38, "iw": 5472},
    "mavic2pro": {"label": "DJI Mavic 2 Pro", "sw": 13.2, "sh": 8.8, "f": 10.26, "iw": 5472},
    "p4p": {"label": "DJI Phantom 4 Pro", "sw": 13.2, "sh": 8.8, "f": 8.8, "iw": 5472},
}


def transformers(lon, lat):
    local = "+proj=tmerc +lat_0=%.7f +lon_0=%.7f +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs" % (lat, lon)
    return Transformer.from_crs("EPSG:4326", local, always_xy=True), Transformer.from_crs(local, "EPSG:4326", always_xy=True)


def rings_of(geom):
    t = geom.get("type")
    if t == "Feature":
        return rings_of(geom["geometry"])
    if t == "Polygon":
        rings = [geom["coordinates"][0]]
    elif t == "MultiPolygon":
        rings = [p[0] for p in geom["coordinates"]]
    else:
        raise ValueError("The area must be a polygon")
    out = []
    for r in rings:
        r = [(float(p[0]), float(p[1])) for p in r]
        if len(r) > 1 and r[0] == r[-1]:
            r = r[:-1]
        if len(r) < 3:
            raise ValueError("The area must have at least 3 points")
        out.append(r)
    return out


def area(ring):
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def clip_edge(pts, inside, intersect):
    out = []
    n = len(pts)
    for i in range(n):
        cur = pts[i]
        prev = pts[i - 1]
        if inside(cur):
            if not inside(prev):
                out.append(intersect(prev, cur))
            out.append(cur)
        elif inside(prev):
            out.append(intersect(prev, cur))
    return out


def clip_box(ring, x0, y0, x1, y1):
    def ix(a, b, x):
        t = (x - a[0]) / (b[0] - a[0])
        return (x, a[1] + t * (b[1] - a[1]))

    def iy(a, b, y):
        t = (y - a[1]) / (b[1] - a[1])
        return (a[0] + t * (b[0] - a[0]), y)

    p = ring
    p = clip_edge(p, lambda q: q[0] >= x0, lambda a, b: ix(a, b, x0)) if p else p
    p = clip_edge(p, lambda q: q[0] <= x1, lambda a, b: ix(a, b, x1)) if p else p
    p = clip_edge(p, lambda q: q[1] >= y0, lambda a, b: iy(a, b, y0)) if p else p
    p = clip_edge(p, lambda q: q[1] <= y1, lambda a, b: iy(a, b, y1)) if p else p
    return p


def split(geom, size):
    rings = rings_of(geom)
    lon0 = sum(p[0] for p in rings[0]) / len(rings[0])
    lat0 = sum(p[1] for p in rings[0]) / len(rings[0])
    fwd, inv = transformers(lon0, lat0)
    rings_m = [list(fwd.itransform(r)) for r in rings]
    xs = [p[0] for r in rings_m for p in r]
    ys = [p[1] for r in rings_m for p in r]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    nx = max(1, math.ceil((maxx - minx) / size))
    ny = max(1, math.ceil((maxy - miny) / size))
    if nx * ny > MAX_CELLS * 4:
        raise ValueError("Too many cells: %s. Choose a larger cell size or a smaller area." % (nx * ny))
    ox = minx - (nx * size - (maxx - minx)) / 2
    oy = maxy + (ny * size - (maxy - miny)) / 2
    min_area = size * size * 0.01
    cells = []
    for row in range(ny):
        y1 = oy - row * size
        y0 = y1 - size
        for col in range(nx):
            x0 = ox + col * size
            x1 = x0 + size
            for r in rings_m:
                p = clip_box(r, x0, y0, x1, y1)
                if len(p) >= 3 and area(p) > min_area:
                    cells.append(p)
    if len(cells) > MAX_CELLS:
        raise ValueError("Too many cells: %s. Choose a larger cell size or a smaller area." % len(cells))
    total = sum(area(r) for r in rings_m)
    out = []
    for c in cells:
        ll = [[round(x, 7), round(y, 7)] for x, y in inv.itransform(c)]
        ll.append(ll[0])
        out.append({"type": "Polygon", "coordinates": [ll]})
    return out, total


def camera(params):
    preset = PRESETS[params["drone"]]
    alt = float(params["altitude"])
    fw = alt * preset["sw"] / preset["f"]
    fh = alt * preset["sh"] / preset["f"]
    line_sp = fw * (1 - float(params["side"]) / 100.0)
    photo_sp = fh * (1 - float(params["front"]) / 100.0)
    gsd = alt * preset["sw"] / (preset["f"] * preset["iw"]) * 100.0
    speed = round(min(10.0, max(1.0, photo_sp / 2.5)), 1)
    return preset, alt, line_sp, photo_sp, gsd, speed


def flight_lines(geom, params):
    preset, alt, line_sp, photo_sp, gsd, speed = camera(params)
    ring = rings_of(geom)[0]
    lon0 = sum(p[0] for p in ring) / len(ring)
    lat0 = sum(p[1] for p in ring) / len(ring)
    fwd, inv = transformers(lon0, lat0)
    pts = list(fwd.itransform(ring))
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    phi = math.radians(90.0 - float(params["angle"]))
    c, s = math.cos(-phi), math.sin(-phi)
    r = [((x - cx) * c - (y - cy) * s, (x - cx) * s + (y - cy) * c) for x, y in pts]
    miny = min(p[1] for p in r)
    maxy = max(p[1] for p in r)
    n = max(1, math.ceil((maxy - miny) / line_sp)) + 1
    start = (miny + maxy) / 2 - (n - 1) * line_sp / 2
    half = line_sp / 2

    def iy(a, b, y):
        t = (y - a[1]) / (b[1] - a[1])
        return (a[0] + t * (b[0] - a[0]), y)

    lines = []
    for i in range(n):
        ly = start + i * line_sp
        band = clip_edge(r, lambda q: q[1] >= ly - half, lambda a, b: iy(a, b, ly - half))
        band = clip_edge(band, lambda q: q[1] <= ly + half, lambda a, b: iy(a, b, ly + half)) if band else band
        if len(band) < 3:
            continue
        x0 = min(p[0] for p in band) - photo_sp
        x1 = max(p[0] for p in band) + photo_sp
        k = max(1, math.ceil((x1 - x0) / photo_sp))
        line = [(x0 + t * (x1 - x0) / k, ly) for t in range(k + 1)]
        if len(lines) % 2 == 1:
            line.reverse()
        lines.append(line)
    flat = [p for line in lines for p in line]
    length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(flat, flat[1:]))
    c, s = math.cos(phi), math.sin(phi)
    out = []
    for line in lines:
        m = [(x * c - y * s + cx, x * s + y * c + cy) for x, y in line]
        out.append([(round(lo, 8), round(la, 8)) for lo, la in inv.itransform(m)])
    return {"lines": out, "length": length, "photos": len(flat), "altitude": alt, "photo_spacing": photo_sp, "line_spacing": line_sp,
            "gsd": gsd, "speed": speed, "preset": preset, "angle": float(params["angle"]) % 360}


def bearing(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dl = math.radians(b[0] - a[0])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return round((math.degrees(math.atan2(y, x)) + 360) % 360, 1)


def export_geojson(geom, idx):
    return json.dumps({"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"cell": idx}, "geometry": geom}]})


def export_kml(geom, idx):
    coords = " ".join("%s,%s" % (p[0], p[1]) for p in geom["coordinates"][0])
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>Cell %s</name>'
            '<Polygon><outerBoundaryIs><LinearRing><coordinates>%s</coordinates></LinearRing></outerBoundaryIs></Polygon>'
            '</Placemark></Document></kml>' % (idx, coords))


def export_litchi(plan):
    cols = ["latitude", "longitude", "altitude(m)", "heading(deg)", "curvesize(m)", "rotationdir",
            "gimbalmode", "gimbalpitchangle"]
    for i in range(1, 16):
        cols += ["actiontype%s" % i, "actionparam%s" % i]
    cols += ["altitudemode", "speed(m/s)", "poi_latitude", "poi_longitude", "poi_altitude(m)",
             "poi_altitudemode", "photo_timeinterval", "photo_distinterval"]
    rows = [",".join(cols)]
    actions = ",".join(["-1,0"] * 15)
    for line in plan["lines"]:
        a, b = line[0], line[-1]
        h = bearing(a, b)
        for p, dist in ((a, round(plan["photo_spacing"], 1)), (b, -1)):
            rows.append("%s,%s,%s,%s,0,0,2,-90,%s,0,%s,0,0,0,0,-1,%s" % (
                p[1], p[0], plan["altitude"], h, actions, plan["speed"], dist))
    return "\n".join(rows) + "\n"


def export_qgc(plan):
    alt = plan["altitude"]
    home = plan["lines"][0][0]
    items = []

    def add(cmd, frame, params):
        items.append({"type": "SimpleItem", "autoContinue": True, "command": cmd, "doJumpId": len(items) + 1,
                      "frame": frame, "params": params})

    add(22, 3, [0, 0, 0, None, home[1], home[0], alt])
    for line in plan["lines"]:
        a, b = line[0], line[-1]
        add(16, 3, [0, 0, 0, None, a[1], a[0], alt])
        add(206, 2, [round(plan["photo_spacing"], 2), 0, 1, 0, 0, 0, 0])
        add(16, 3, [0, 0, 0, None, b[1], b[0], alt])
        add(206, 2, [0, 0, 1, 0, 0, 0, 0])
    add(20, 2, [0, 0, 0, 0, 0, 0, 0])
    return json.dumps({
        "fileType": "Plan", "version": 1, "groundStation": "QGroundControl",
        "geoFence": {"circles": [], "polygons": [], "version": 2},
        "rallyPoints": {"points": [], "version": 2},
        "mission": {"version": 2, "firmwareType": 12, "vehicleType": 2, "cruiseSpeed": plan["speed"],
                    "hoverSpeed": plan["speed"], "globalPlanAltitudeMode": 1,
                    "plannedHomePosition": [home[1], home[0], 0], "items": items}
    }, indent=1)


GIMBAL_ACTION = ("<wpml:action><wpml:actionId>0</wpml:actionId><wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>"
                 "<wpml:actionActuatorFuncParam><wpml:gimbalRotateMode>absoluteAngle</wpml:gimbalRotateMode>"
                 "<wpml:gimbalPitchRotateEnable>1</wpml:gimbalPitchRotateEnable><wpml:gimbalPitchRotateAngle>-90</wpml:gimbalPitchRotateAngle>"
                 "<wpml:gimbalRollRotateEnable>0</wpml:gimbalRollRotateEnable><wpml:gimbalRollRotateAngle>0</wpml:gimbalRollRotateAngle>"
                 "<wpml:gimbalYawRotateEnable>0</wpml:gimbalYawRotateEnable><wpml:gimbalYawRotateAngle>0</wpml:gimbalYawRotateAngle>"
                 "<wpml:gimbalRotateTimeEnable>0</wpml:gimbalRotateTimeEnable><wpml:gimbalRotateTime>0</wpml:gimbalRotateTime>"
                 "<wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:actionActuatorFuncParam></wpml:action>")
PHOTO_ACTION = ("<wpml:action><wpml:actionId>%s</wpml:actionId><wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>"
                "<wpml:actionActuatorFuncParam><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:actionActuatorFuncParam></wpml:action>")


def action_group(gid, start, end, trigger, actions):
    return ("<wpml:actionGroup><wpml:actionGroupId>%s</wpml:actionGroupId><wpml:actionGroupStartIndex>%s</wpml:actionGroupStartIndex>"
            "<wpml:actionGroupEndIndex>%s</wpml:actionGroupEndIndex><wpml:actionGroupMode>sequence</wpml:actionGroupMode>"
            "<wpml:actionTrigger>%s</wpml:actionTrigger>%s</wpml:actionGroup>" % (gid, start, end, trigger, actions))


def max_waypoints(preset):
    return DJI_FLY_MAX_WAYPOINTS if preset["dji"][0] == 68 else DJI_PILOT_MAX_WAYPOINTS


def export_kmz(plan):
    dji = plan["preset"]["dji"]
    alt = plan["altitude"]
    speed = plan["speed"]
    points = [p for line in plan["lines"] for p in line]
    limit = max_waypoints(plan["preset"])
    if len(points) > limit:
        raise ValueError("Too many waypoints for this drone (%s, max %s). Use smaller cells or fly higher." % (len(points), limit))
    reach = "<wpml:actionTriggerType>reachPoint</wpml:actionTriggerType>"
    groups = {i: action_group(i, i, i, reach, (GIMBAL_ACTION if i == 0 else "") + PHOTO_ACTION % 1) for i in range(len(points))}

    payload = ""
    if dji[2]:
        payload = "<wpml:payloadInfo><wpml:payloadEnumValue>%s</wpml:payloadEnumValue><wpml:payloadPositionIndex>0</wpml:payloadPositionIndex></wpml:payloadInfo>" % dji[2]
    config = ("<wpml:missionConfig><wpml:flyToWaylineMode>safely</wpml:flyToWaylineMode><wpml:finishAction>goHome</wpml:finishAction>"
              "<wpml:exitOnRCLost>executeLostAction</wpml:exitOnRCLost><wpml:executeRCLostAction>goBack</wpml:executeRCLostAction>"
              "<wpml:takeOffSecurityHeight>20</wpml:takeOffSecurityHeight><wpml:globalTransitionalSpeed>%s</wpml:globalTransitionalSpeed>"
              "<wpml:droneInfo><wpml:droneEnumValue>%s</wpml:droneEnumValue><wpml:droneSubEnumValue>%s</wpml:droneSubEnumValue></wpml:droneInfo>%s"
              "</wpml:missionConfig>" % (speed, dji[0], dji[1], payload))
    head = '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.2"><Document>'
    turn = "toPointAndStopWithDiscontinuityCurvature"
    now = int(time.time() * 1000)

    tpl = [head, "<wpml:author>WebODM</wpml:author><wpml:createTime>%s</wpml:createTime><wpml:updateTime>%s</wpml:updateTime>" % (now, now), config,
           "<Folder><wpml:templateType>waypoint</wpml:templateType><wpml:templateId>0</wpml:templateId>"
           "<wpml:waylineCoordinateSysParam><wpml:coordinateMode>WGS84</wpml:coordinateMode><wpml:heightMode>relativeToStartPoint</wpml:heightMode></wpml:waylineCoordinateSysParam>"
           "<wpml:autoFlightSpeed>%s</wpml:autoFlightSpeed><wpml:globalHeight>%s</wpml:globalHeight><wpml:caliFlightEnable>0</wpml:caliFlightEnable>"
           "<wpml:gimbalPitchMode>manual</wpml:gimbalPitchMode><wpml:globalWaypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode></wpml:globalWaypointHeadingParam>"
           "<wpml:globalWaypointTurnMode>%s</wpml:globalWaypointTurnMode><wpml:globalUseStraightLine>1</wpml:globalUseStraightLine>" % (speed, alt, turn)]
    wpl = [head, config,
           "<Folder><wpml:templateId>0</wpml:templateId><wpml:executeHeightMode>relativeToStartPoint</wpml:executeHeightMode>"
           "<wpml:waylineId>0</wpml:waylineId><wpml:autoFlightSpeed>%s</wpml:autoFlightSpeed>" % speed]
    for i, p in enumerate(points):
        pt = "<Point><coordinates>%s,%s</coordinates></Point><wpml:index>%s</wpml:index>" % (p[0], p[1], i)
        g = groups.get(i, "")
        tpl.append("<Placemark>%s<wpml:ellipsoidHeight>%s</wpml:ellipsoidHeight><wpml:height>%s</wpml:height>"
                   "<wpml:useGlobalHeight>1</wpml:useGlobalHeight><wpml:useGlobalSpeed>1</wpml:useGlobalSpeed>"
                   "<wpml:useGlobalHeadingParam>1</wpml:useGlobalHeadingParam><wpml:useGlobalTurnParam>1</wpml:useGlobalTurnParam>"
                   "<wpml:useStraightLine>1</wpml:useStraightLine>%s</Placemark>" % (pt, alt, alt, g))
        wpl.append("<Placemark>%s<wpml:executeHeight>%s</wpml:executeHeight><wpml:waypointSpeed>%s</wpml:waypointSpeed>"
                   "<wpml:waypointHeadingParam><wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode></wpml:waypointHeadingParam>"
                   "<wpml:waypointTurnParam><wpml:waypointTurnMode>%s</wpml:waypointTurnMode><wpml:waypointTurnDampingDist>0</wpml:waypointTurnDampingDist></wpml:waypointTurnParam>"
                   "<wpml:useStraightLine>1</wpml:useStraightLine>%s</Placemark>" % (pt, alt, speed, turn, g))
    tpl.append("</Folder></Document></kml>")
    wpl.append("</Folder></Document></kml>")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("wpmz/template.kml", "".join(tpl))
        z.writestr("wpmz/waylines.wpml", "".join(wpl))
    return buf.getvalue()
