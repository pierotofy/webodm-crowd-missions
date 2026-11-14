(function(){
    var _ = MM._, f = MM.f, esc = MM.esc;
    var $id = function(id){ return document.getElementById(id); };
    var colors = MM.colors();
    var map = MM.map("mm-map");
    var shell = $id("mm-shell");
    var VIEWS = ["overview", "cell", "people", "processing"];
    var viewKey = "mm-view-" + MM.missionId;

    var STATUS = {
        available: _("Available"),
        claimed: _("Claimed"),
        submitted: _("Waiting for review"),
        reflight: _("Reflight requested"),
        approved: _("Approved")
    };
    var FORMATS = {
        kmz: _("DJI (KMZ)"),
        csv: _("Litchi (CSV)"),
        plan: _("QGroundControl (.plan)"),
        kml: _("Boundary (KML)"),
        geojson: _("Boundary (GeoJSON)")
    };
    var IMAGE_RE = /\.(jpe?g|tiff?|png|dng)$/i;
    var CONCURRENCY = 4, RETRIES = 3;

    var mission = null, lastJson = "", cells = {}, selected = null, fitted = false;
    map.createPane("mmPhotos").style.zIndex = 450;
    var layers = {}, cellsLayer = L.layerGroup().addTo(map), photosLayer = L.layerGroup().addTo(map);
    var images = [], imagesFor = null, showImages = false, reflightOpen = false;
    var path = MM.path(map), pathInfo = null, pathFor = null, photoMarkers = {};
    var draft = null, draftTimer = null, draftSeq = 0, flightNotice = null;
    var imgUrl = function(cid, i, kind){ return MM.apiUrl + cellPath(cid) + "/images/" + i.id + "/" + kind + "?v=" + i.size + "-256"; };
    var notice = null, upload = null, presets = null, presetValue = null, processing = false;

    var people = null, peopleManage = null;
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".mm-tab"));

    var shown = function(){ return tabs.filter(function(t){ return !t.hidden; }); };

    var setView = function(v, focusPanel){
        if (VIEWS.indexOf(v) === -1 || $id("mm-tab-" + v).hidden) v = "overview";
        shell.setAttribute("data-view", v);
        tabs.forEach(function(t){
            var on = t.getAttribute("data-view") === v;
            t.setAttribute("aria-selected", on ? "true" : "false");
            t.tabIndex = on ? 0 : -1;
            t.querySelector(".mm-tab-icon").classList.toggle("theme-background-highlight", on);
        });
        try{ sessionStorage.setItem(viewKey, v); }catch(e){}
        var panel = $id("mm-panel-" + v);
        if (focusPanel && panel){
            var r = panel.getBoundingClientRect();
            if (r.top < 0 || r.top > window.innerHeight * 0.5) panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    };

    tabs.forEach(function(t){
        t.onclick = function(){ setView(t.getAttribute("data-view"), true); };
        t.onkeydown = function(e){
            var list = shown(), i = list.indexOf(t), n = null;
            if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (i + 1) % list.length;
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (i - 1 + list.length) % list.length;
            else if (e.key === "Home") n = 0;
            else if (e.key === "End") n = list.length - 1;
            if (n === null) return;
            e.preventDefault();
            list[n].focus();
            setView(list[n].getAttribute("data-view"));
        };
    });

    var initialView = null;
    try{ initialView = sessionStorage.getItem(viewKey); }catch(e){}
    setView(/^#cell-\d+$/.test(location.hash) ? "cell" : (initialView || "overview"));

    var cellPath = function(cid){ return "missions/" + MM.missionId + "/cells/" + cid; };

    var styleFor = function(c){
        var mine = c.pilot_id === mission.user_id;
        return {
            color: colors[c.status],
            weight: c.id === selected ? 4 : (mine ? 2.5 : 1.5),
            opacity: 1,
            fillColor: colors[c.status],
            fillOpacity: c.status === "available" ? 0.08 : 0.35,
            dashArray: mine && c.id !== selected ? "6 4" : null
        };
    };

    var tooltip = function(c){
        var t = f("Cell %(cell)s", {cell: c.idx}) + " · " + STATUS[c.status];
        if (c.pilot_name) t += " · " + c.pilot_name;
        return esc(t);
    };

    var renderMap = function(){
        cellsLayer.clearLayers();
        layers = {};
        mission.cells.forEach(function(c){
            var l = L.geoJSON(c.geom, { style: styleFor(c) });
            l.bindTooltip(tooltip(c), { sticky: true });
            l.on("click", function(){ select(c.id, false, true); });
            l.addTo(cellsLayer);
            layers[c.id] = l;
        });
        if (!fitted && mission.cells.length){
            fitted = true;
            map.fitBounds(L.geoJSON(mission.aoi).getBounds(), { padding: [20, 20] });
        }
    };

    var restyle = function(){
        mission.cells.forEach(function(c){
            if (layers[c.id]) layers[c.id].setStyle(styleFor(c));
        });
        if (selected && layers[selected]) layers[selected].bringToFront();
    };

    var renderHead = function(){
        var m = mission, counts = {}, mine = [];
        Object.keys(STATUS).forEach(function(k){ counts[k] = 0; });
        m.cells.forEach(function(c){
            counts[c.status]++;
            if (c.pilot_id === m.user_id && c.status !== "approved") mine.push(c);
        });
        var total = m.cells.length;
        var pct = total ? Math.round(100 * counts.approved / total) : 0;
        var p = m.params;
        $id("mm-title").textContent = m.name;
        $id("mm-subtitle").textContent = f("Project: %(project)s", {project: m.project.name});
        document.title = m.name + " - " + document.title.split(" - ").pop();
        var stat = function(icon, value, label){
            return '<li class="mm-stat theme-border-highlight"><i class="fa ' + icon + '" aria-hidden="true"></i>' +
                '<span class="mm-stat-value">' + esc(value) + '</span><span class="mm-stat-label text-muted">' + esc(label) + '</span></li>';
        };
        var h = '<div class="mm-sub-head"><h3 class="mm-sub-title">' + esc(_("Flight")) + '</h3>' +
            (m.can_manage && !draft ? '<button type="button" class="btn btn-default" id="mm-edit-flight"><i class="fa fa-pen" aria-hidden="true"></i> ' + esc(_("Edit")) + '</button>' : '') + '</div>';
        if (draft){
            h += flightForm();
        }else{
            h += '<ul class="mm-stats">' +
                stat("fa-helicopter", m.drone, _("Drone")) +
                stat("fa-arrows-alt-v", p.altitude + " m", _("Altitude")) +
                stat("fa-crosshairs", (Math.round(m.gsd * 10) / 10) + " cm/px", _("Resolution")) +
                stat("fa-clone", p.front + " / " + p.side + "%", _("Overlap")) +
                stat("fa-compass", p.angle + "°", _("Direction")) +
                '</ul>';
            if (flightNotice) h += '<div class="alert alert-success" role="status">' + esc(flightNotice) + '</div>';
        }
        h +=
            '<h3 class="mm-sub-title mm-sub">' + esc(_("Cells")) + '</h3>' +
            '<div class="mm-progress-head"><span>' + esc(f("%(approved)s / %(total)s approved", {approved: counts.approved, total: total})) + '</span>' +
            '<span class="text-muted">' + pct + '%</span></div>' +
            '<div class="progress mm-progress-wide" role="progressbar" aria-label="' + esc(_("Approved cells")) + '" aria-valuemin="0" aria-valuemax="' + total + '" aria-valuenow="' + counts.approved + '">' +
            '<div class="progress-bar progress-bar-success" style="width:' + pct + '%"></div></div>' +
            '<ul class="mm-counts">';
        Object.keys(STATUS).forEach(function(k){
            h += '<li' + (counts[k] ? '' : ' class="text-muted"') + '><span class="mm-swatch" style="background:' + colors[k] + '"></span>' +
                '<span class="mm-count-label">' + esc(STATUS[k]) + '</span><span class="mm-count">' + counts[k] + '</span></li>';
        });
        h += '</ul><div class="form-group mm-sub"><label class="sr-only" for="mm-goto">' + esc(_("Cell")) + '</label><select class="form-control" id="mm-goto">' +
            '<option value="">' + esc(_("Go to cell...")) + '</option>';
        m.cells.forEach(function(c){
            h += '<option value="' + c.id + '"' + (c.id === selected ? " selected" : "") + '>' +
                esc(f("Cell %(cell)s", {cell: c.idx}) + " · " + STATUS[c.status] + (c.pilot_name ? " · " + c.pilot_name : "")) + '</option>';
        });
        h += '</select></div>';
        if (mine.length){
            h += '<h3 class="mm-sub-title">' + esc(_("Your cells")) + '</h3><div class="mm-chips">';
            mine.forEach(function(c){
                h += '<button type="button" class="btn btn-default" data-cell="' + c.id + '" aria-label="' + esc(f("Cell %(cell)s", {cell: c.idx}) + " · " + STATUS[c.status]) + '">' + c.idx + '</button>';
            });
            h += '</div>';
        }
        $id("mm-head").innerHTML = h;
        if ($id("mm-edit-flight")) $id("mm-edit-flight").onclick = function(){
            draft = JSON.parse(JSON.stringify(mission.params));
            flightNotice = null;
            renderHead();
            $id("mm-e-drone").focus();
            previewDraft();
        };
        if (draft) bindFlightForm();
        MM.tips($id("mm-head"));
        $id("mm-goto").onchange = function(){ select(this.value ? parseInt(this.value) : null, true, true); };
        Array.prototype.forEach.call($id("mm-head").querySelectorAll("[data-cell]"), function(b){
            b.onclick = function(){ select(parseInt(b.getAttribute("data-cell")), true, true); };
        });
    };

    var flightForm = function(){
        var opt = function(v, cur, label){ return '<option value="' + v + '"' + (String(v) === String(cur) ? " selected" : "") + '>' + esc(label) + '</option>'; };
        var overlap = function(cur){
            var o = "";
            for (var v = 60; v <= 90; v += 5) o += opt(v, cur, v + "%");
            return o;
        };
        var label = function(id, text, tip){
            return '<div class="mm-label"><label for="' + id + '">' + esc(text) + '</label>' + MM.tip(tip) + '</div>';
        };
        var h = '<div class="form-group">' + label("mm-e-drone", _("Drone"), _("Sets the camera used to space photos.")) +
            '<select class="form-control" id="mm-e-drone">';
        Object.keys(MM.presets).forEach(function(k){ h += opt(k, draft.drone, MM.presets[k].label); });
        h += '</select></div><div class="mm-row">' +
            '<div class="form-group">' + label("mm-e-altitude", _("Altitude (m)"), _("Height above takeoff. Lower gives more detail but needs more photos.")) +
            '<input type="number" class="form-control" id="mm-e-altitude" min="10" max="500" step="1" value="' + esc(draft.altitude) + '"></div>' +
            '<div class="form-group">' + label("mm-e-angle", _("Direction (°)"), _("Heading of the flight lines. 0° is north.")) +
            '<input type="number" class="form-control" id="mm-e-angle" min="0" max="359" step="1" value="' + esc(draft.angle) + '"></div></div>' +
            '<div class="mm-row">' +
            '<div class="form-group">' + label("mm-e-front", _("Front overlap"), _("Overlap between photos along a line. Higher improves results.")) +
            '<select class="form-control" id="mm-e-front">' + overlap(draft.front) + '</select></div>' +
            '<div class="form-group">' + label("mm-e-side", _("Side overlap"), _("Overlap between neighboring lines. Higher improves results.")) +
            '<select class="form-control" id="mm-e-side">' + overlap(draft.side) + '</select></div></div>' +
            '<p class="mm-path-stats" id="mm-e-stats" aria-live="polite"></p>' +
            '<div class="alert alert-warning" id="mm-e-msg" role="alert" hidden></div>' +
            '<div class="mm-buttons"><button type="button" class="btn btn-primary" id="mm-e-save"><i class="fa fa-check" aria-hidden="true"></i> ' + esc(_("Save")) + '</button>' +
            '<button type="button" class="btn btn-default" id="mm-e-cancel"><i class="fa fa-times" aria-hidden="true"></i> ' + esc(_("Cancel")) + '</button></div>';
        return h;
    };

    var readDraft = function(){
        draft = {
            drone: $id("mm-e-drone").value,
            altitude: parseFloat($id("mm-e-altitude").value),
            front: parseFloat($id("mm-e-front").value),
            side: parseFloat($id("mm-e-side").value),
            angle: parseFloat($id("mm-e-angle").value) || 0
        };
    };

    var draftGsd = function(){
        var pr = MM.presets[draft.drone];
        return pr && draft.altitude > 0 ? '<span class="mm-path-stat" title="' + esc(_("Resolution")) + '"><i class="fa fa-crosshairs" aria-hidden="true"></i>' +
            (Math.round(draft.altitude * pr.sw / (pr.f * pr.iw) * 1000) / 10) + ' cm/px</span>' : '';
    };

    var previewDraft = function(){
        clearTimeout(draftTimer);
        if (!draft) return;
        var stats = $id("mm-e-stats");
        if (stats) stats.innerHTML = draftGsd();
        if (!selected || !cells[selected]){
            path.clear();
            return;
        }
        draftTimer = setTimeout(function(){
            var seq = ++draftSeq, cid = selected;
            MM.api("POST", "path", { geom: cells[cid].geom, params: draft }).then(function(r){
                if (seq !== draftSeq || !draft) return;
                path.draw(r);
                pathFor = null;
                var st = $id("mm-e-stats");
                if (st) st.innerHTML = '<span class="mm-path-stat"><strong>' + esc(f("Cell %(cell)s", {cell: cells[cid].idx})) + '</strong></span>' + draftGsd() + MM.pathStats(r);
            }).catch(function(){
                if (seq !== draftSeq) return;
                path.clear();
            });
        }, 120);
    };

    var endEdit = function(){
        draft = null;
        clearTimeout(draftTimer);
        draftSeq++;
        pathFor = null;
        renderHead();
        if (selected) loadPath(selected);
        else path.clear();
    };

    var bindFlightForm = function(){
        ["mm-e-drone", "mm-e-altitude", "mm-e-angle", "mm-e-front", "mm-e-side"].forEach(function(id){
            ["input", "change"].forEach(function(ev){
                $id(id).addEventListener(ev, function(){ readDraft(); previewDraft(); });
            });
        });
        $id("mm-e-cancel").onclick = endEdit;
        $id("mm-e-save").onclick = function(){
            var btn = this;
            readDraft();
            btn.disabled = true;
            MM.api("PATCH", "missions/" + MM.missionId, { params: draft }).then(function(){
                flightNotice = _("Saved. Pilots need to download their flight plans again.");
                draft = null;
                lastJson = "";
                return load().then(endEdit);
            }).catch(function(e){
                btn.disabled = false;
                var m = $id("mm-e-msg");
                m.textContent = e.message;
                m.hidden = false;
            });
        };
    };

    var renderCell = function(){
        var el = $id("mm-cell");
        var c = selected ? cells[selected] : null;
        var title = $id("mm-panel-cell").querySelector(".mm-pane-title");
        title.innerHTML = c ? esc(f("Cell %(cell)s", {cell: c.idx})) + ' <span class="mm-status"><span class="mm-swatch" style="background:' + colors[c.status] + '"></span>' + esc(STATUS[c.status] + (c.pilot_name ? " · " + (c.pilot_id === mission.user_id ? _("you") : c.pilot_name) : "")) + '</span>' : esc(_("Cell"));
        if (!c){
            el.innerHTML = '<p class="help-block">' + esc(_("Select a cell on the map.")) + '</p>';
            return;
        }
        var m = mission, mine = c.pilot_id === m.user_id, manage = m.can_manage;
        var flying = mine && (c.status === "claimed" || c.status === "reflight");
        var h = pathFor === c.id && pathInfo ? '<p class="mm-path-stats">' + MM.pathStats(pathInfo) + '</p>' : '';

        if (c.status === "reflight" && c.note) h += '<div class="alert alert-warning">' + esc(f("Reason for reflight: %(note)s", {note: c.note})) + '</div>';
        else if (c.status === "reflight") h += '<div class="alert alert-warning">' + esc(_("Fly this cell again.")) + '</div>';
        if (c.images) h += '<p>' + esc(MM.n("%(count)s image (%(size)s)", "%(count)s images (%(size)s)", c.images, {count: c.images, size: MM.bytes(c.bytes)})) + '</p>';
        if (notice) h += '<div class="alert ' + (notice.ok ? "alert-success" : "alert-warning") + '" role="alert">' + esc(notice.text) + '</div>';

        if (c.status === "available"){
            h += '<div class="mm-buttons"><button type="button" class="btn btn-primary" data-act="claim" data-toggle="tooltip" title="' + esc(_("Reserves the cell so only you fly it.")) + '"><i class="fa fa-flag" aria-hidden="true"></i> ' + esc(_("Claim this cell")) + '</button></div>';
        }

        if (c.status !== "approved"){
            h += '<div class="form-group mm-plan"><div class="mm-label"><label for="mm-format">' + esc(_("Flight plan")) + '</label>' +
                MM.tip(_("Open the file in your flight app.")) + '</div><div class="mm-inline">' +
                '<select class="form-control" id="mm-format">';
            m.formats.forEach(function(k){ h += '<option value="' + k + '">' + esc(FORMATS[k]) + '</option>'; });
            h += '</select><button type="button" class="btn btn-default" id="mm-download"><i class="fa fa-download"></i> ' + esc(_("Download")) + '</button></div></div>';
        }

        if (flying){
            if (upload && upload.cid === c.id){
                h += '<div class="mm-upload"><div class="progress"><div class="progress-bar" id="mm-up-bar" style="width:0%"></div></div>' +
                    '<p id="mm-up-text" aria-live="polite"></p><button type="button" class="btn btn-default" id="mm-up-stop"><i class="fa fa-stop" aria-hidden="true"></i> ' + esc(_("Stop")) + '</button></div>';
            }else{
                h += '<div class="mm-buttons">' +
                    '<button type="button" class="btn btn-default" id="mm-upload" data-toggle="tooltip" title="' + esc(_("JPG, TIFF, PNG or DNG")) + '"><i class="fa fa-upload" aria-hidden="true"></i> ' + esc(_("Upload images")) + '</button>' +
                    '<input type="file" id="mm-files" multiple accept="image/*,.dng" hidden></div>';
                if (!upload) h += '<div class="mm-buttons">' +
                    '<button type="button" class="btn btn-primary" data-act="submit"' + (c.images ? '' : ' disabled') + '><i class="fa fa-paper-plane" aria-hidden="true"></i> ' + esc(_("Submit for review")) + '</button>' +
                    '<button type="button" class="btn btn-default" data-act="release" data-toggle="tooltip" title="' + esc(_("Give the cell back to other pilots.")) + '"><i class="fa fa-undo" aria-hidden="true"></i> ' + esc(_("Release cell")) + '</button></div>';
            }
        }

        if (manage && c.status === "submitted"){
            h += '<div class="mm-buttons"><button type="button" class="btn btn-primary" data-act="approve"><i class="fa fa-check" aria-hidden="true"></i> ' + esc(_("Approve")) + '</button>' +
                '<button type="button" class="btn btn-default" id="mm-reflight-open"><i class="fa fa-redo" aria-hidden="true"></i> ' + esc(_("Request reflight...")) + '</button></div>';
        }else if (manage && c.status === "approved"){
            h += '<div class="mm-buttons"><button type="button" class="btn btn-default" id="mm-reflight-open"><i class="fa fa-redo" aria-hidden="true"></i> ' + esc(_("Request reflight...")) + '</button></div>';
        }
        if (manage && reflightOpen){
            h += '<div class="form-group mm-reflight"><div class="mm-label"><label for="mm-note">' + esc(_("Reason")) + '</label>' + MM.tip(_("Shown to the pilot.")) + '</div>' +
                '<textarea class="form-control" id="mm-note" rows="2" maxlength="1000"></textarea></div>' +
                '<div class="mm-buttons"><button type="button" class="btn btn-primary" data-act="reflight"><i class="fa fa-redo" aria-hidden="true"></i> ' + esc(MM.n("Delete %(count)s image and request reflight", "Delete %(count)s images and request reflight", c.images, {count: c.images})) + '</button>' +
                '<button type="button" class="btn btn-default" id="mm-reflight-cancel"><i class="fa fa-times" aria-hidden="true"></i> ' + esc(_("Cancel")) + '</button></div>';
        }
        if (manage && !flying && c.status !== "available" && !reflightOpen){
            h += '<div class="mm-buttons"><button type="button" class="btn btn-default" data-act="release"><i class="fa fa-undo" aria-hidden="true"></i> ' + esc(_("Release cell")) + '</button></div>';
        }

        if (imagesFor === c.id && images.length){
            h += '<div class="mm-buttons"><button type="button" class="btn btn-default" id="mm-toggle-images" aria-expanded="' + (showImages ? "true" : "false") + '">' +
                '<i class="fa ' + (showImages ? "fa-eye-slash" : "fa-images") + '" aria-hidden="true"></i> ' +
                esc(showImages ? _("Hide images") : f("Show images (%(count)s)", {count: images.length})) + '</button></div>';
            if (showImages){
                var canRemove = flying || (manage && c.status !== "approved");
                h += '<div class="media-grid mm-media-grid">';
                images.forEach(function(i){
                    h += '<div class="media-card">' +
                        '<div class="media-view"><div class="mm-media-spin"><i class="fa fa-circle-notch fa-spin fa-fw media-loading"></i></div>' +
                        '<div class="media-thumb-container"><div class="media-view-image"><div class="media-thumb mm-static" draggable="false">' +
                        '<img draggable="false" style="visibility:hidden;border-radius:4px" loading="lazy" src="' + imgUrl(c.id, i, "thumb") + '" alt="' + esc(i.filename) + '" title="' + esc(i.filename) + '">' +
                        '</div></div></div></div>' +
                        '<div class="card-details theme-secondary"><div class="card-filename theme-secondary-complementary" title="' + esc(i.filename) + '">' + esc(i.filename) + '</div></div>' +
                        (canRemove ? '<button type="button" class="card-delete-btn btn btn-xs btn-danger" data-remove="' + i.id + '" title="' + esc(_("Delete")) + '" aria-label="' + esc(f("Delete %(file)s", {file: i.filename})) + '"><i class="fa fa-trash" aria-hidden="true"></i></button>' : '') +
                        '</div>';
                });
                h += '</div>';
            }
        }
        el.innerHTML = h;

        Array.prototype.forEach.call(el.querySelectorAll("[data-act]"), function(b){
            b.onclick = function(){ act(c, b.getAttribute("data-act"), b); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-remove]"), function(b){
            b.onclick = function(){ removeImage(c, parseInt(b.getAttribute("data-remove")), b); };
        });
        if ($id("mm-download")) $id("mm-download").onclick = function(){ downloadPlan(c, $id("mm-format").value, this); };
        if ($id("mm-upload")) $id("mm-upload").onclick = function(){ $id("mm-files").click(); };
        if ($id("mm-files")) $id("mm-files").onchange = function(){ startUpload(c, this.files); };
        if ($id("mm-up-stop")) $id("mm-up-stop").onclick = function(){ stopUpload(); };
        if ($id("mm-reflight-open")) $id("mm-reflight-open").onclick = function(){ reflightOpen = true; renderCell(); $id("mm-note").focus(); };
        if ($id("mm-reflight-cancel")) $id("mm-reflight-cancel").onclick = function(){ reflightOpen = false; renderCell(); };
        if ($id("mm-toggle-images")) $id("mm-toggle-images").onclick = function(){ showImages = !showImages; renderCell(); };
        Array.prototype.forEach.call(el.querySelectorAll(".media-card"), function(card){
            var img = card.querySelector("img"), view = card.querySelector(".media-view");
            var done = function(){
                var sp = card.querySelector(".mm-media-spin");
                if (sp) sp.remove();
                img.style.visibility = "visible";
                view.classList.add("theme-secondary-complementary");
            };
            img.onload = done;
            img.onerror = function(){
                var sp = card.querySelector(".mm-media-spin");
                if (sp) sp.remove();
                card.querySelector(".media-thumb-container").innerHTML = '<div style="margin-top:8px">' + esc(_("Image missing")) + '</div>';
            };
            if (img.complete && img.naturalWidth) done();
        });
        if (upload && upload.cid === c.id) uploadProgress();
        MM.tips(el);
    };

    var renderManage = function(){
        var el = $id("mm-manage"), m = mission;
        if (!m.can_manage){
            el.innerHTML = renderTasks() || '<p class="help-block">' + esc(_("No results yet.")) + '</p>';
            return;
        }
        var approved = 0, imgs = 0, waiting = 0;
        m.cells.forEach(function(c){
            if (c.status === "approved"){ approved++; imgs += c.images; }
            if (c.status === "submitted") waiting++;
        });
        var h = '<p class="mm-label">' + esc(MM.n("%(images)s images from %(cells)s approved cell", "%(images)s images from %(cells)s approved cells", approved, {images: imgs, cells: approved})) + ' ' +
            MM.tip(MM.f("Creates a new task in project %(project)s.", {project: m.project.name})) + '</p>';
        if (waiting) h += '<p class="help-block">' + esc(MM.n("%(count)s cell awaiting review is skipped.", "%(count)s cells awaiting review are skipped.", waiting, {count: waiting})) + '</p>';
        h += '<div class="form-group"><div class="mm-label"><label for="mm-preset">' + esc(_("Preset")) + '</label>' + MM.tip(_("Processing options to use.")) + '</div><select class="form-control" id="mm-preset">';
        (presets || []).forEach(function(p){
            h += '<option value="' + p.id + '"' + (String(p.id) === String(presetValue) ? " selected" : "") + '>' + esc(p.name) + '</option>';
        });
        h += '</select></div><div class="mm-buttons"><button type="button" class="btn btn-primary" id="mm-process"' + (processing ? " disabled" : "") + '>' +
            '<i class="fa ' + (processing ? "fa-circle-notch fa-spin" : "fa-play") + '" aria-hidden="true"></i> ' +
            esc(processing ? _("Starting processing...") : _("Start processing")) + '</button></div>' +
            (notice && notice.manage ? '<div class="alert ' + (notice.ok ? "alert-success" : "alert-warning") + '" role="alert">' + esc(notice.text) + '</div>' : '') +
            renderTasks() +
            '<div class="mm-sub"><div class="mm-buttons"><button type="button" class="btn btn-danger" id="mm-delete" data-toggle="tooltip" title="' +
            esc(_("Deletes cells and uploads. Project tasks are kept.")) + '"><i class="fa fa-trash" aria-hidden="true"></i> ' + esc(_("Delete mission")) + '</button></div></div>';
        el.innerHTML = h;
        $id("mm-preset").onchange = function(){ presetValue = this.value; };
        $id("mm-process").onclick = startProcessing;
        $id("mm-delete").onclick = deleteMission;
        MM.tips(el);
    };

    var renderTasks = function(){
        if (!mission.tasks.length) return "";
        var h = '<div class="mm-sub"><h3 class="mm-sub-title">' + esc(_("Results")) + '</h3><ul class="mm-tasks">';
        mission.tasks.forEach(function(t){
            var label = t.status_label + (t.progress != null ? " " + t.progress + "%" : "");
            h += '<li>' + esc(new Date(t.created_at).toLocaleString()) + ' · ' + esc(MM.n("%(count)s image", "%(count)s images", t.images, {count: t.images})) + ' · ' + esc(label) +
                '<div class="mm-links">' + (t.status === 40 ? '<a href="' + t.map_url + '">' + esc(_("Open map")) + '</a>' : '') +
                '<a href="' + t.dashboard_url + '">' + esc(_("Open in dashboard")) + '</a></div></li>';
        });
        return h + '</ul></div>';
    };

    var render = function(){
        var proc = $id("mm-tab-processing");
        proc.hidden = !mission.can_manage;
        $id("mm-panel-processing").hidden = !mission.can_manage;
        if (proc.hidden && shell.getAttribute("data-view") === "processing") setView("overview");
        cells = {};
        mission.cells.forEach(function(c){ cells[c.id] = c; });
        if (selected && !cells[selected]) selected = null;
        renderMap();
        renderHead();
        renderCell();
        renderManage();
    };

    var photoPopup = function(cid, i){
        return '<div class="mm-photo-pop">' +
            '<img src="' + imgUrl(cid, i, "thumb") + '" alt="' + esc(i.filename) + '" style="max-height:' + Math.max(80, Math.min(160, map.getSize().y - 150)) + 'px">' +
            '<div class="mm-photo-name"><span class="mm-filename" title="' + esc(i.filename) + '">' + esc(i.filename) + '</span></div></div>';
    };

    var drawPhotos = function(){
        photosLayer.clearLayers();
        photoMarkers = {};
        if (imagesFor !== selected) return;
        var cid = imagesFor;
        images.forEach(function(i){
            if (i.lat == null) return;
            photoMarkers[i.id] = L.circleMarker([i.lat, i.lon], { pane: "mmPhotos", radius: 6, weight: 2, color: "#FFFFFF", fillColor: "#FBBC04", fillOpacity: 1, bubblingMouseEvents: false })
                .bindTooltip(esc(i.filename))
                .bindPopup(function(){ return photoPopup(cid, i); }, { maxWidth: 260, minWidth: 200, autoPanPaddingTopLeft: [16, 72], autoPanPaddingBottomRight: [16, 16] })
                .addTo(photosLayer);
        });
    };

    var loadImages = function(cid){
        if (!cid || !cells[cid] || !cells[cid].images){
            images = [];
            imagesFor = cid;
            drawPhotos();
            renderCell();
            return Promise.resolve();
        }
        return MM.api("GET", cellPath(cid) + "/images").then(function(r){
            if (selected !== cid) return;
            images = r;
            imagesFor = cid;
            drawPhotos();
            renderCell();
        }).catch(function(){});
    };

    var loadPath = function(cid){
        pathFor = null;
        pathInfo = null;
        path.clear();
        if (!cid) return;
        MM.api("GET", cellPath(cid) + "/path").then(function(r){
            if (selected !== cid) return;
            pathFor = cid;
            pathInfo = r;
            path.draw(r);
            renderCell();
        }).catch(function(){});
    };

    var select = function(cid, zoom, show){
        if (selected !== cid){
            notice = null;
            reflightOpen = false;
            showImages = !!(cid && cells[cid] && mission.can_manage && cells[cid].status === "submitted");
            images = [];
            imagesFor = null;
        }
        selected = cid;
        var c = cid ? cells[cid] : null;
        history.replaceState(null, "", c ? "#cell-" + c.idx : location.pathname);
        restyle();
        if (zoom && c && layers[cid]) map.fitBounds(layers[cid].getBounds(), { padding: [40, 40], maxZoom: 18 });
        if ($id("mm-goto")) $id("mm-goto").value = cid || "";
        renderCell();
        loadImages(cid);
        if (draft) previewDraft();
        else if (cid !== pathFor) loadPath(cid);
        if (show && cid) setView("cell", true);
    };

    var load = function(){
        return MM.api("GET", "missions/" + MM.missionId).then(function(m){
            var j = JSON.stringify(m);
            if (j === lastJson) return;
            lastJson = j;
            mission = m;
            if (selected === null){
                var h = location.hash.match(/^#cell-(\d+)$/), first = null;
                if (h) m.cells.forEach(function(c){ if (c.idx === parseInt(h[1])){ first = c.id; } });
                render();
                if (initialView === "processing" && m.can_manage && !first) setView("processing");
                if (first) select(first, true);
            }else{
                var prev = imagesFor && cells[imagesFor] ? cells[imagesFor].images : null;
                render();
                if (selected && m.cells.some(function(c){ return c.id === selected && c.images !== prev; })) loadImages(selected);
            }
        }).catch(function(e){
            if (!mission) $id("mm-head").innerHTML = '<div class="alert alert-warning" role="alert">' + esc(e.message === "Not found." ? _("This mission does not exist or is not shared with you.") : e.message) + '</div>';
        });
    };

    var setNotice = function(text, ok, manage){
        notice = text ? { text: text, ok: !!ok, manage: !!manage } : null;
    };

    var act = function(c, action, btn){
        var go = function(){
            var body = action === "reflight" ? { note: $id("mm-note").value } : {};
            btn.disabled = true;
            setNotice(null);
            return MM.api("POST", cellPath(c.id) + "/" + action, body).then(function(){
                reflightOpen = false;
                if (action === "claim") setNotice(_("Claimed."), true);
                else if (action === "submit") setNotice(_("Submitted for review."), true);
                lastJson = "";
                return load().then(function(){ return loadImages(c.id); });
            }).catch(function(e){
                setNotice(e.message);
                lastJson = "";
                return load().then(renderCell);
            });
        };
        if (action === "release" && c.images){
            MM.confirm(f("Release cell %(cell)s?", {cell: c.idx}),
                MM.n("Its %(count)s image will be deleted.", "Its %(count)s images will be deleted.", c.images, {count: c.images}))
                .then(function(yes){ if (yes) go(); });
        }else{
            go();
        }
    };

    var removeImage = function(c, iid, btn){
        btn.disabled = true;
        MM.api("DELETE", cellPath(c.id) + "/images/" + iid).then(function(){
            lastJson = "";
            return load().then(function(){ return loadImages(c.id); });
        }).catch(function(e){
            setNotice(e.message);
            renderCell();
        });
    };

    var downloadPlan = function(c, fmt, btn){
        btn.disabled = true;
        setNotice(null);
        fetch(MM.apiUrl + cellPath(c.id) + "/plan." + fmt, { credentials: "same-origin" }).then(function(r){
            if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(j){
                throw new Error(MM.errorText(j) || _("Unable to create the flight plan. Try again."));
            });
            var name = (r.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
            return r.blob().then(function(b){
                var a = document.createElement("a");
                a.href = URL.createObjectURL(b);
                a.download = name ? name[1] : "cell" + c.idx + "." + fmt;
                document.body.appendChild(a);
                a.click();
                setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
                btn.disabled = false;
            });
        }).catch(function(e){
            setNotice(e.message);
            renderCell();
        });
    };

    var uploadProgress = function(){
        if (!upload || !$id("mm-up-bar")) return;
        var loaded = 0;
        Object.keys(upload.loaded).forEach(function(k){ loaded += upload.loaded[k]; });
        var pct = upload.bytes ? Math.min(100, 100 * loaded / upload.bytes) : 0;
        $id("mm-up-bar").style.width = pct.toFixed(1) + "%";
        $id("mm-up-text").textContent = upload.stopped ? _("Stopping upload...") :
            f("Uploading %(done)s of %(total)s images · %(loaded)s of %(size)s", {done: upload.done, total: upload.total, loaded: MM.bytes(loaded), size: MM.bytes(upload.bytes)});
    };

    var send = function(file, attempt){
        return new Promise(function(resolve){
            var xhr = new XMLHttpRequest();
            var key = upload.keys.get(file);
            upload.xhrs.add(xhr);
            var retry = function(){
                upload.xhrs.delete(xhr);
                upload.loaded[key] = 0;
                if (attempt < RETRIES && !upload.stopped){
                    setTimeout(function(){ send(file, attempt + 1).then(resolve); }, 2000 * (attempt + 1));
                }else{
                    resolve(null);
                }
            };
            xhr.open("POST", MM.apiUrl + cellPath(upload.cid) + "/images");
            xhr.setRequestHeader("X-CSRFToken", MM.csrf());
            xhr.upload.onprogress = function(e){
                upload.loaded[key] = e.total ? file.size * e.loaded / e.total : 0;
                uploadProgress();
            };
            xhr.onload = function(){
                upload.xhrs.delete(xhr);
                if (xhr.status >= 200 && xhr.status < 300){
                    upload.loaded[key] = file.size;
                    resolve(true);
                }else if (xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429){
                    var detail = null;
                    try{ detail = MM.errorText(JSON.parse(xhr.responseText)); }catch(e){}
                    upload.loaded[key] = 0;
                    resolve(detail || false);
                }else{
                    retry();
                }
            };
            xhr.onerror = retry;
            xhr.onabort = function(){ upload.xhrs.delete(xhr); upload.loaded[key] = 0; resolve(null); };
            var form = new FormData();
            form.append("file", file, file.name);
            xhr.send(form);
        });
    };

    var startUpload = function(c, fileList){
        var all = Array.prototype.slice.call(fileList || []);
        var files = all.filter(function(fl){ return IMAGE_RE.test(fl.name); });
        var skipped = all.length - files.length;
        if (!files.length){
            setNotice(_("No images selected. Use JPG, TIFF, PNG or DNG."));
            renderCell();
            return;
        }
        upload = { cid: c.id, total: files.length, done: 0, failed: [], problem: null, bytes: 0, loaded: {}, keys: new Map(), xhrs: new Set(), stopped: false };
        files.forEach(function(fl, i){ upload.bytes += fl.size; upload.keys.set(fl, i); });
        setNotice(null);
        renderCell();
        var queue = files.slice(), active = 0;
        var next = function(){
            if (upload.stopped || !queue.length){
                if (active === 0) finish(skipped);
                return;
            }
            var file = queue.shift();
            active++;
            send(file, 0).then(function(ok){
                active--;
                if (ok === true) upload.done++;
                else{
                    upload.failed.push(file.name);
                    if (typeof ok === "string") upload.problem = ok;
                }
                uploadProgress();
                next();
            });
        };
        for (var i = 0; i < CONCURRENCY; i++) next();
    };

    var stopUpload = function(){
        if (!upload) return;
        upload.stopped = true;
        upload.xhrs.forEach(function(x){ x.abort(); });
        uploadProgress();
    };

    var finish = function(skipped){
        var u = upload;
        if (!u || u.finished) return;
        u.finished = true;
        upload = null;
        var parts = [];
        if (u.stopped) parts.push(f("Stopped. %(done)s of %(total)s uploaded.", {done: u.done, total: u.total}));
        else if (u.failed.length){
            parts.push(f("Unable to upload %(files)s.", {files: u.failed.slice(0, 3).join(", ") + (u.failed.length > 3 ? "..." : "")}));
            parts.push(u.problem || _("Try again."));
        }else parts.push(MM.n("%(count)s image uploaded.", "%(count)s images uploaded.", u.done, {count: u.done}));
        if (skipped) parts.push(MM.n("%(count)s non-image skipped.", "%(count)s non-images skipped.", skipped, {count: skipped}));
        setNotice(parts.join(" "), !u.stopped && !u.failed.length);
        lastJson = "";
        load().then(function(){ return loadImages(u.cid); }).then(renderCell);
    };

    var loadPresets = function(){
        if (!mission || !mission.can_manage || presets) return;
        fetch("/api/presets/?ordering=-system,-created_at", { credentials: "same-origin" }).then(function(r){ return r.json(); }).then(function(list){
            presets = Array.isArray(list) ? list : [];
            if (presetValue === null){
                var def = presets.filter(function(p){ return p.system && p.name === "Default"; })[0] || presets[0];
                presetValue = def ? def.id : "";
            }
            renderManage();
        }).catch(function(){ presets = []; renderManage(); });
    };

    var startProcessing = function(){
        processing = true;
        setNotice(null);
        renderManage();
        MM.api("POST", "missions/" + MM.missionId + "/process", { preset: presetValue || null }).then(function(r){
            processing = false;
            setNotice(_("Processing started."), true, true);
            lastJson = "";
            return load().then(renderManage);
        }).catch(function(e){
            processing = false;
            setNotice(e.message, false, true);
            renderManage();
        });
    };

    var deleteMission = function(){
        var imgs = 0;
        mission.cells.forEach(function(c){ imgs += c.images; });
        MM.confirm(f("Delete mission %(name)s?", {name: mission.name}),
            MM.n("Deletes %(count)s uploaded image. Project tasks are kept.", "Deletes %(count)s uploaded images. Project tasks are kept.", imgs, {count: imgs}))
            .then(function(yes){
                if (!yes) return;
                MM.api("DELETE", "missions/" + MM.missionId).then(function(){
                    window.location.href = MM.pluginUrl;
                }).catch(function(e){
                    setNotice(e.message, false, true);
                    renderManage();
                });
            });
    };

    window.addEventListener("beforeunload", function(e){
        if (upload){
            e.preventDefault();
            e.returnValue = "";
        }
    });

    setInterval(function(){
        if (document.visibilityState === "visible" && !upload && !processing && !reflightOpen && !draft) load();
    }, 15000);

    var applyAccess = function(r){
        if (r.left){
            window.location.href = MM.pluginUrl;
            return null;
        }
        if (!people || peopleManage !== r.can_manage){
            peopleManage = r.can_manage;
            people = MM.people($id("mm-people"), {
                canManage: r.can_manage,
                me: r.me,
                set: function(kind, name, role){
                    return MM.api("POST", "missions/" + MM.missionId + "/access", { kind: kind, name: name, role: role }).then(afterAccess);
                },
                setOpen: function(v){
                    return MM.api("POST", "missions/" + MM.missionId + "/access", { open: v }).then(afterAccess);
                },
                beforeRemove: function(e){
                    if (e.kind === "group"){
                        return MM.confirm(MM.f("Remove group %(name)s?", {name: e.name}),
                            _("Members without other access lose access to the project."));
                    }
                    if (e.name === r.me){
                        return MM.confirm(_("Remove your own access?"), _("You will no longer see this mission."));
                    }
                    var held = mission.cells.filter(function(c){ return c.pilot_name === e.name && (c.status === "claimed" || c.status === "reflight"); });
                    if (!held.length) return true;
                    var imgs = held.reduce(function(a, c){ return a + c.images; }, 0);
                    return MM.confirm(MM.f("Remove %(name)s?", {name: e.name}),
                        MM.n("Releases %(cells)s claimed cell.", "Releases %(cells)s claimed cells.", held.length, {cells: held.length}) + (imgs ? " " +
                        MM.n("Deletes %(images)s image.", "Deletes %(images)s images.", imgs, {images: imgs}) : ""));
                }
            });
        }
        var st = { entries: r.entries, open: r.open, project: r.project };
        people.update(st);
        return st;
    };

    var afterAccess = function(r){
        var st = applyAccess(r);
        lastJson = "";
        load();
        return st;
    };

    var loadAccess = function(){
        return MM.api("GET", "missions/" + MM.missionId + "/access").then(applyAccess).catch(function(){});
    };

    load().then(loadPresets).then(loadAccess);
})();
