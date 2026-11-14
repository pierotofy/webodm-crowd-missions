(function(){
    var _ = MM._;
    var $id = function(id){ return document.getElementById(id); };
    var colors = MM.colors();
    var map = MM.map("mm-map");
    var aoi = null, aoiLayer = null, gridLayer = null, gridCount = 0, gridTimer = null, gridSeq = 0;
    var drawing = false, pts = [], drawLayer = L.layerGroup().addTo(map);
    var cells = [], preview = -1, path = MM.path(map), pathTimer = null, pathSeq = 0;

    var drone = $id("mm-drone");
    Object.keys(MM.presets).forEach(function(k){
        var o = document.createElement("option");
        o.value = k;
        o.textContent = MM.presets[k].label;
        drone.appendChild(o);
    });
    [["mm-front", 80], ["mm-side", 70]].forEach(function(s){
        for (var v = 60; v <= 90; v += 5){
            var o = document.createElement("option");
            o.value = v;
            o.textContent = v + "%";
            if (v === s[1]) o.selected = true;
            $id(s[0]).appendChild(o);
        }
    });

    var message = function(text){
        var m = $id("mm-message");
        m.textContent = text || "";
        m.hidden = !text;
    };

    var summary = function(){
        var p = MM.presets[drone.value];
        var alt = parseFloat($id("mm-altitude").value);
        var size = parseFloat($id("mm-cell-size").value);
        var parts = [];
        if (aoi && gridCount) parts.push(MM.n("%(cells)s cell", "%(cells)s cells", gridCount, {cells: gridCount}));
        if (p && alt > 0){
            var gsd = alt * p.sw / (p.f * p.iw) * 100;
            var lineSp = alt * p.sw / p.f * (1 - $id("mm-side").value / 100);
            var photoSp = alt * p.sh / p.f * (1 - $id("mm-front").value / 100);
            var photos = Math.round((size / lineSp + 2) * (size / photoSp + 3));
            parts.push(MM.f("%(gsd)s cm/pixel", {gsd: gsd.toFixed(1)}));
            parts.push(MM.f("~%(photos)s photos/cell", {photos: photos}));
        }
        $id("mm-summary").textContent = parts.join(" · ");
        var warn = $id("mm-warn");
        warn.hidden = !(p && p.max_wp && photos > p.max_wp);
        if (!warn.hidden) warn.textContent = MM.f("Too many photos per cell for %(drone)s (about %(max)s max). Use smaller cells or fly higher.", {drone: p.label, max: p.max_wp});
    };

    var params = function(){
        return {
            drone: drone.value,
            altitude: parseFloat($id("mm-altitude").value),
            front: parseFloat($id("mm-front").value),
            side: parseFloat($id("mm-side").value),
            angle: parseFloat($id("mm-angle").value) || 0
        };
    };

    var ringArea = function(g){
        var r = g.coordinates[0], a = 0;
        for (var i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
        return Math.abs(a);
    };

    var gridStyle = function(f){
        var on = f.properties.i === preview;
        return { color: colors.available, weight: on ? 3 : 1.5, opacity: 1, fill: true, fillColor: colors.available, fillOpacity: on ? 0.15 : 0.01 };
    };

    var refreshPath = function(){
        clearTimeout(pathTimer);
        if (preview < 0 || !cells[preview]){
            pathSeq++;
            path.clear();
            $id("mm-path").innerHTML = "";
            return;
        }
        pathTimer = setTimeout(function(){
            var seq = ++pathSeq, i = preview;
            MM.api("POST", "path", { geom: cells[i], params: params() }).then(function(r){
                if (seq !== pathSeq) return;
                path.draw(r);
                $id("mm-path").innerHTML = '<span class="mm-path-stat"><strong>' + MM.esc(MM.f("Cell %(cell)s", {cell: i + 1})) + '</strong></span>' + MM.pathStats(r);
            }).catch(function(){
                if (seq !== pathSeq) return;
                path.clear();
                $id("mm-path").innerHTML = "";
            });
        }, 120);
    };

    var refreshGrid = function(){
        clearTimeout(gridTimer);
        if (!aoi){
            if (gridLayer) map.removeLayer(gridLayer);
            gridLayer = null;
            gridCount = 0;
            cells = [];
            refreshPath();
            summary();
            return;
        }
        gridTimer = setTimeout(function(){
            var seq = ++gridSeq;
            MM.api("POST", "grid", { aoi: aoi, cell_size: parseFloat($id("mm-cell-size").value) }).then(function(r){
                if (seq !== gridSeq) return;
                if (gridLayer) map.removeLayer(gridLayer);
                cells = r.cells;
                if (preview < 0 || preview >= cells.length){
                    preview = 0;
                    cells.forEach(function(g, i){ if (ringArea(g) > ringArea(cells[preview])) preview = i; });
                }
                gridLayer = L.geoJSON({ type: "FeatureCollection", features: cells.map(function(g, i){ return { type: "Feature", properties: { i: i }, geometry: g }; }) }, {
                    style: gridStyle,
                    onEachFeature: function(f, l){
                        l.options.bubblingMouseEvents = false;
                        l.bindTooltip(MM.esc(MM.f("Cell %(cell)s", {cell: f.properties.i + 1})), { sticky: true });
                        l.on("click", function(){
                            preview = f.properties.i;
                            gridLayer.setStyle(gridStyle);
                            refreshPath();
                        });
                    }
                }).addTo(map);
                gridCount = r.cells.length;
                refreshPath();
                message("");
                summary();
            }).catch(function(e){
                if (seq !== gridSeq) return;
                gridCount = 0;
                cells = [];
                refreshPath();
                if (gridLayer) map.removeLayer(gridLayer);
                gridLayer = null;
                message(e.message);
                summary();
            });
        }, 250);
    };

    var setAoi = function(geom){
        aoi = geom;
        preview = -1;
        if (aoiLayer) map.removeLayer(aoiLayer);
        aoiLayer = null;
        if (geom){
            aoiLayer = L.geoJSON(geom, { style: { color: colors.link, weight: 3, fillOpacity: 0.1, interactive: false } }).addTo(map);
            map.fitBounds(aoiLayer.getBounds(), { padding: [20, 20] });
        }
        $id("mm-clear").hidden = !geom;
        refreshGrid();
    };

    var redrawSketch = function(){
        drawLayer.clearLayers();
        if (pts.length > 1) L.polyline(pts, { color: colors.link, weight: 2, dashArray: "4 4", interactive: false }).addTo(drawLayer);
        pts.forEach(function(p, i){
            var m = L.circleMarker(p, { radius: i === 0 ? 7 : 4, color: colors.link, fillOpacity: 1, bubblingMouseEvents: false }).addTo(drawLayer);
            if (i === 0) m.on("click", finishDrawing);
        });
    };

    var startDrawing = function(){
        drawing = true;
        pts = [];
        setAoi(null);
        redrawSketch();
        map.getContainer().classList.add("mm-drawing");
        $id("mm-draw").hidden = true;
        $id("mm-finish").hidden = false;
        $id("mm-draw-help").textContent = _("Click to add corners. Enter finishes, Esc cancels.");
        $id("mm-draw-help").hidden = false;
        map.getContainer().focus();
    };

    var stopDrawing = function(){
        drawing = false;
        pts = [];
        drawLayer.clearLayers();
        map.getContainer().classList.remove("mm-drawing");
        $id("mm-draw").hidden = false;
        $id("mm-finish").hidden = true;
        $id("mm-draw-help").hidden = true;
    };

    var finishDrawing = function(){
        if (!drawing) return;
        if (pts.length < 3){
            message(_("Add at least 3 corners."));
            return;
        }
        var ring = pts.map(function(p){ return [p.lng, p.lat]; });
        ring.push(ring[0]);
        stopDrawing();
        message("");
        setAoi({ type: "Polygon", coordinates: [ring] });
    };

    map.on("click", function(e){
        if (!drawing) return;
        pts.push(e.latlng);
        redrawSketch();
    });
    document.addEventListener("keydown", function(e){
        if (!drawing) return;
        if (e.key === "Enter"){ e.preventDefault(); finishDrawing(); }
        else if (e.key === "Escape"){ stopDrawing(); }
    });

    $id("mm-draw").onclick = startDrawing;
    $id("mm-finish").onclick = finishDrawing;
    $id("mm-clear").onclick = function(){ setAoi(null); };

    var polygonsFrom = function(g, out){
        if (!g) return;
        if (g.type === "FeatureCollection") g.features.forEach(function(f){ polygonsFrom(f, out); });
        else if (g.type === "Feature") polygonsFrom(g.geometry, out);
        else if (g.type === "GeometryCollection") g.geometries.forEach(function(x){ polygonsFrom(x, out); });
        else if (g.type === "Polygon") out.push(g.coordinates);
        else if (g.type === "MultiPolygon") g.coordinates.forEach(function(p){ out.push(p); });
    };

    var parseKml = function(text){
        var doc = new DOMParser().parseFromString(text, "application/xml");
        var out = [];
        Array.prototype.forEach.call(doc.getElementsByTagName("outerBoundaryIs"), function(ob){
            var c = ob.getElementsByTagName("coordinates")[0];
            if (!c) return;
            var ring = c.textContent.trim().split(/\s+/).map(function(t){
                var v = t.split(",");
                return [parseFloat(v[0]), parseFloat(v[1])];
            }).filter(function(p){ return !isNaN(p[0]) && !isNaN(p[1]); });
            if (ring.length >= 3) out.push([ring]);
        });
        return out;
    };

    $id("mm-file").onchange = function(e){
        var file = e.target.files[0];
        e.target.value = "";
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(){
            var polys = [];
            try{
                if (/\.kml$/i.test(file.name)) polys = parseKml(reader.result);
                else polygonsFrom(JSON.parse(reader.result), polys);
            }catch(err){
                polys = [];
            }
            if (!polys.length){
                message(MM.f("No area found in %(file)s.", {file: file.name}));
                return;
            }
            if (drawing) stopDrawing();
            message("");
            setAoi(polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys });
        };
        reader.readAsText(file);
    };

    $id("mm-cell-size").onchange = function(){ preview = -1; refreshGrid(); summary(); };
    ["mm-drone", "mm-altitude", "mm-front", "mm-side", "mm-angle"].forEach(function(id){
        ["input", "change"].forEach(function(ev){
            $id(id).addEventListener(ev, function(){ summary(); refreshPath(); });
        });
    });

    $id("mm-form").onsubmit = function(e){
        e.preventDefault();
        var name = $id("mm-name").value.trim();
        if (!name){
            message(_("Type a name for the mission."));
            $id("mm-name").focus();
            return;
        }
        if (!aoi){
            message(_("Draw or import the area to map."));
            $id("mm-draw").focus();
            return;
        }
        var btn = $id("mm-create");
        btn.disabled = true;
        btn.innerHTML = '<i class="fa fa-circle-notch fa-spin" aria-hidden="true"></i> ' + MM.esc(_("Creating mission..."));
        message("");
        MM.api("POST", "missions", {
            name: name,
            project: $id("mm-project").value,
            aoi: aoi,
            cell_size: parseFloat($id("mm-cell-size").value),
            params: params(),
            open: people.state().open,
            access: people.state().entries.filter(function(e){ return !e.owner; }).map(function(e){ return { kind: e.kind, name: e.name, role: e.role }; })
        }).then(function(r){
            window.location.href = MM.pluginUrl + r.id + "/";
        }).catch(function(err){
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> ' + MM.esc(_("Create mission"));
            message(err.message);
        });
    };

    var exists = function(kind, name){
        var url = kind === "group" ? MM.apiUrl + "groups?search=" : "/api/users/?limit=50&search=";
        return fetch(url + encodeURIComponent(name), { credentials: "same-origin" }).then(function(r){
            if (!r.ok) return true;
            return r.json().then(function(items){
                return items.some(function(i){ return (typeof i === "string" ? i : i.username) === name; });
            });
        }, function(){ return true; });
    };

    var people = MM.people($id("mm-people"), {
        canManage: true,
        me: MM.me,
        set: function(kind, name, role){
            var s = people.state();
            var entries = s.entries.filter(function(e){ return !(e.kind === kind && e.name === name); });
            if (role === "none") return Object.assign({}, s, { entries: entries });
            var cur = s.entries.filter(function(e){ return e.kind === kind && e.name === name; })[0];
            if (cur && cur.owner) return Promise.reject(new Error(MM.f("%(name)s owns this project and always has full access.", {name: name})));
            if (cur) return Object.assign({}, s, { entries: s.entries.map(function(e){ return e === cur ? Object.assign({}, e, { role: role }) : e; }) });
            return exists(kind, name).then(function(ok){
                if (!ok) throw new Error(kind === "group" ?
                    MM.f("No group named \"%(name)s\" exists. Check the name and try again.", {name: name}) :
                    MM.f("No user named \"%(name)s\" exists. Check the name and try again.", {name: name}));
                entries.push({ kind: kind, name: name, role: role, owner: false });
                return Object.assign({}, s, { entries: entries });
            });
        },
        setOpen: function(v){ return Object.assign({}, people.state(), { open: v }); }
    });

    var loadAccess = function(){
        var pid = $id("mm-project").value;
        var open = people.state().open;
        if (pid === "new"){
            people.update({ entries: [{ kind: "user", name: MM.me, role: "manager", owner: true }], open: open });
            return;
        }
        var label = $id("mm-project").selectedOptions[0].textContent;
        people.update({ entries: [], open: open, note: _("Loading...") });
        MM.api("GET", "projects/" + pid + "/access").then(function(r){
            if ($id("mm-project").value !== pid) return;
            people.update({ entries: r.entries, open: open, project: label });
        }).catch(function(e){
            people.update({ entries: [], open: open, project: label, note: e.message });
        });
    };
    $id("mm-project").onchange = loadAccess;
    loadAccess();
    summary();
    MM.tips(document);
})();
