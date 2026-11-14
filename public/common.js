(function(){
    var gt = window.gettext || function(s){ return s; };
    var fmt = window.interpolate || function(s, o){ return s.replace(/%\((\w+)\)s/g, function(_, k){ return o[k]; }); };

    MM._ = gt;
    MM.f = function(s, o){ return fmt(gt(s), o, true); };
    var ngt = window.ngettext || function(a, b, n){ return n === 1 ? a : b; };
    MM.n = function(one, many, n, o){ return fmt(ngt(one, many, n), o, true); };

    MM.csrf = function(){
        var m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
        return m ? decodeURIComponent(m[1]) : "";
    };

    MM.errorText = function(j){
        if (j == null) return null;
        if (typeof j === "string") return j;
        if (Array.isArray(j)) return MM.errorText(j[0]);
        if (typeof j === "object"){
            if (j.detail) return MM.errorText(j.detail);
            if (j.error) return MM.errorText(j.error);
            var k = Object.keys(j)[0];
            return k ? MM.errorText(j[k]) : null;
        }
        return String(j);
    };

    MM.api = function(method, path, body){
        var opts = { method: method, credentials: "same-origin", headers: { "X-CSRFToken": MM.csrf() } };
        if (body !== undefined){
            opts.headers["Content-Type"] = "application/json";
            opts.body = JSON.stringify(body);
        }
        return fetch(MM.apiUrl + path, opts).then(function(r){
            return r.json().catch(function(){ return {}; }).then(function(j){
                if (!r.ok) throw new Error(MM.errorText(j) || MM.f("The server could not complete the request (status %(status)s). Try again.", {status: r.status}));
                return j;
            });
        }, function(){
            throw new Error(gt("Unable to reach the server. Check the connection and try again."));
        });
    };

    MM.colors = function(){
        var probe = function(cls, prop){
            var el = document.createElement(cls === "a" ? "a" : "div");
            if (cls !== "a") el.className = cls;
            el.style.display = "none";
            document.body.appendChild(el);
            var v = getComputedStyle(el)[prop];
            document.body.removeChild(el);
            return v;
        };
        return {
            primary: getComputedStyle(document.body).color,
            available: "#FFFFFF",
            claimed: "#4285F4",
            submitted: "#FBBC04",
            approved: "#34A853",
            reflight: "#EA4335",
            link: probe("a", "color")
        };
    };

    MM.map = function(id){
        var map = L.map(id, { maxZoom: 22 });
        var layers = {};
        var first = null;
        (MM.basemaps || []).forEach(function(b){
            var opts = { attribution: b.attribution, maxZoom: 22, maxNativeZoom: b.maxzoom, minZoom: b.minzoom };
            if (b.subdomains) opts.subdomains = b.subdomains;
            var layer;
            if (b.type === "wms"){
                opts.layers = b.layers;
                opts.format = b.format || "image/png";
                opts.styles = b.styles || "";
                layer = L.tileLayer.wms(b.url, opts);
            }else{
                layer = L.tileLayer(b.url, opts);
            }
            layers[b.label] = layer;
            if (!first) first = layer;
        });
        if (!first){
            first = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 22, maxNativeZoom: 19 });
        }
        first.addTo(map);
        if (Object.keys(layers).length > 1) L.control.layers(layers, null, { position: "topright" }).addTo(map);
        L.control.scale({ imperial: false }).addTo(map);
        map.setView([20, 0], 2);
        MM.geocoder(map);
        if (window.ResizeObserver) new ResizeObserver(function(){ map.invalidateSize(); }).observe(map.getContainer());
        MM.fold(map.getContainer());
        MM.fill(map.getContainer());
        return map;
    };

    MM.fill = function(mapEl){
        var app = mapEl.closest(".mm-app");
        var body = app && app.querySelector(".mm-body");
        if (!body) return;
        var apply = function(){
            app.style.setProperty("--mm-top", Math.round(body.getBoundingClientRect().top + window.scrollY) + "px");
        };
        apply();
        window.addEventListener("resize", apply);
    };

    MM.fold = function(mapEl){
        var app = mapEl.closest(".mm-app");
        var body = app && app.querySelector(".mm-body");
        if (!body) return;
        var apply = function(){
            var segs = window.viewport && window.viewport.segments;
            app.classList.remove("mm-folded", "mm-folded-v");
            if (!segs || segs.length !== 2) return;
            var a = segs[0], b = segs[1];
            if (a.right <= b.left){
                var hinge = b.left - a.right, gap = Math.max(24, hinge);
                var col = (a.right + b.left) / 2 - gap / 2 - body.getBoundingClientRect().left;
                app.style.setProperty("--mm-fold-a", Math.max(0, Math.round(col)) + "px");
                app.style.setProperty("--mm-fold-gap", Math.round(gap) + "px");
                app.classList.add("mm-folded");
            }else if (a.bottom <= b.top){
                var h = a.bottom - mapEl.getBoundingClientRect().top - 12;
                app.style.setProperty("--mm-fold-map-h", Math.max(200, Math.round(h)) + "px");
                app.classList.add("mm-folded-v");
            }
        };
        apply();
        window.addEventListener("resize", apply);
    };

    MM.confirm = function(question, detail, yes, no){
        return new Promise(function(resolve){
            var m = document.createElement("div");
            m.className = "modal fade mm-modal";
            m.setAttribute("tabindex", "-1");
            m.setAttribute("role", "dialog");
            m.innerHTML = '<div class="modal-dialog" role="document"><div class="modal-content">' +
                '<div class="modal-body"><p class="mm-question"></p><p class="mm-detail"></p></div>' +
                '<div class="modal-footer"><button type="button" class="btn btn-primary mm-yes"></button>' +
                '<button type="button" class="btn btn-default mm-no"></button></div></div></div>';
            m.querySelector(".mm-question").textContent = question;
            m.querySelector(".mm-detail").textContent = detail || "";
            m.querySelector(".mm-yes").innerHTML = '<i class="fa fa-check" aria-hidden="true"></i> ' + MM.esc(yes || gt("Yes"));
            m.querySelector(".mm-no").innerHTML = '<i class="fa fa-times" aria-hidden="true"></i> ' + MM.esc(no || gt("No"));
            document.body.appendChild(m);
            var answer = false;
            m.querySelector(".mm-yes").onclick = function(){ answer = true; $(m).modal("hide"); };
            m.querySelector(".mm-no").onclick = function(){ $(m).modal("hide"); };
            $(m).on("shown.bs.modal", function(){ m.querySelector(".mm-no").focus(); });
            $(m).on("hidden.bs.modal", function(){ $(m).remove(); resolve(answer); });
            $(m).modal("show");
        });
    };

    MM.path = function(map){
        if (!map.getPane("mmPath")) map.createPane("mmPath").style.zIndex = 440;
        var group = L.layerGroup().addTo(map), dots = L.layerGroup();
        var showDots = function(){
            if (map.getZoom() >= 16) dots.addTo(map);
            else map.removeLayer(dots);
        };
        map.on("zoomend", showDots);
        showDots();
        return {
            draw: function(d){
                group.clearLayers();
                dots.clearLayers();
                var pts = [];
                d.lines.forEach(function(line){ line.forEach(function(p){ pts.push([p[1], p[0]]); }); });
                if (!pts.length) return;
                L.polyline(pts, { pane: "mmPath", color: "#FFFFFF", weight: 6, opacity: 0.9, interactive: false }).addTo(group);
                L.polyline(pts, { pane: "mmPath", color: "#1A73E8", weight: 3, opacity: 1, interactive: false }).addTo(group);
                pts.forEach(function(p){
                    L.circleMarker(p, { pane: "mmPath", radius: 2.5, weight: 1, color: "#1A73E8", fillColor: "#FFFFFF", fillOpacity: 1, interactive: false }).addTo(dots);
                });
                L.circleMarker(pts[0], { pane: "mmPath", radius: 7, weight: 2, color: "#FFFFFF", fillColor: "#34A853", fillOpacity: 1 })
                    .bindTooltip(gt("Start")).addTo(group);
            },
            clear: function(){ group.clearLayers(); dots.clearLayers(); }
        };
    };

    MM.pathStats = function(d){
        return [
            ["fa-camera", MM.n("%(n)s photo", "%(n)s photos", d.photos, {n: d.photos}), gt("Photos")],
            ["fa-route", (d.length / 1000).toFixed(1) + " km", gt("Flight distance")]
        ].map(function(x){
            return '<span class="mm-path-stat" title="' + MM.esc(x[2]) + '"><i class="fa ' + x[0] + '" aria-hidden="true"></i><span class="sr-only">' + MM.esc(x[2]) + ': </span>' + MM.esc(x[1]) + '</span>';
        }).join("");
    };

    MM.tip = function(text){
        var t = MM.esc(text);
        return '<button type="button" class="mm-info" data-toggle="tooltip" title="' + t + '" aria-label="' + t + '"><i class="fa fa-info-circle" aria-hidden="true"></i></button>';
    };

    MM.tips = function(root){
        if (!$.fn.tooltip){
            window.addEventListener("load", function(){ MM.tips(root); }, { once: true });
            return;
        }
        $(".tooltip").remove();
        $(root || document).find('[data-toggle="tooltip"]').tooltip({ container: "body", trigger: "hover focus", placement: "auto top" });
    };

    MM.bytes = function(b){
        var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
        while (b >= 1024 && i < u.length - 1){ b /= 1024; i++; }
        return (i ? b.toFixed(1) : b) + " " + u[i];
    };

    MM.esc = function(s){
        var d = document.createElement("div");
        d.textContent = s == null ? "" : String(s);
        return d.innerHTML;
    };

    var ROLES = { pilot: gt("Pilot"), manager: gt("Manager") };

    MM.people = function(el, o){
        var esc = MM.esc, state = { entries: [], open: false, project: "" }, error = "", busy = false;
        var kind = "user", role = "pilot", timer = null, uid = "mm-people-" + Math.random().toString(36).slice(2);
        el.mmOwner = uid;

        var suggest = function(q){
            clearTimeout(timer);
            var list = document.getElementById(uid + "-list");
            if (!list) return;
            if (!q){ list.innerHTML = ""; return; }
            timer = setTimeout(function(){
                var url = kind === "group" ? MM.apiUrl + "groups?search=" : "/api/users/?limit=10&search=";
                fetch(url + encodeURIComponent(q), { credentials: "same-origin" }).then(function(r){ return r.ok ? r.json() : []; }).then(function(items){
                    list.innerHTML = items.map(function(i){
                        return typeof i === "string" ? '<option value="' + esc(i) + '">' :
                            '<option value="' + esc(i.username) + '">' + esc(i.email || "") + '</option>';
                    }).join("");
                }).catch(function(){});
            }, 250);
        };

        var run = function(p){
            busy = true;
            error = "";
            render();
            return Promise.resolve(p).then(function(s){
                busy = false;
                if (s) state = s;
                render();
                return true;
            }, function(e){
                busy = false;
                error = e.message;
                render();
                return false;
            });
        };

        var render = function(){
            if (el.mmOwner !== uid) return;
            var h = (state.note ? '<p class="help-block">' + esc(state.note) + '</p>' : '') +
                '<ul class="mm-people-list">';
            state.entries.forEach(function(e, i){
                var label = e.name + (e.kind === "user" && e.name === o.me ? " " + gt("(you)") : "");
                h += '<li><i class="fa ' + (e.kind === "group" ? "fa-users" : "fa-user") + '" title="' + esc(e.kind === "group" ? gt("Group") : gt("User")) + '"></i> ' +
                    '<span class="mm-person">' + esc(label) + '</span>';
                if (o.canManage && !e.owner){
                    h += '<select class="form-control" data-role="' + i + '" aria-label="' + esc(MM.f("Role for %(name)s", {name: e.name})) + '"' + (busy ? " disabled" : "") + '>' +
                        Object.keys(ROLES).map(function(k){ return '<option value="' + k + '"' + (k === e.role ? " selected" : "") + '>' + esc(ROLES[k]) + '</option>'; }).join("") +
                        '</select><button type="button" class="btn btn-default mm-icon-btn" data-remove="' + i + '" title="' + esc(gt("Remove")) + '" aria-label="' + esc(MM.f("Remove %(name)s", {name: e.name})) + '"' + (busy ? " disabled" : "") + '><i class="fa fa-times"></i></button>';
                }else{
                    h += '<span class="text-muted">' + esc(e.owner ? gt("Owner") : ROLES[e.role]) + '</span>';
                }
                h += '</li>';
            });
            h += '</ul>';
            if (o.canManage){
                h += '<div class="mm-label"><label for="' + uid + '-name">' + esc(gt("Add a person or group")) + '</label>' +
                    MM.tip(gt("Pilots fly and upload. Managers also review, process and manage access.")) + '</div><div class="mm-add">' +
                    '<select class="form-control" id="' + uid + '-kind" aria-label="' + esc(gt("Type")) + '">' +
                    '<option value="user"' + (kind === "user" ? " selected" : "") + '>' + esc(gt("User")) + '</option>' +
                    '<option value="group"' + (kind === "group" ? " selected" : "") + '>' + esc(gt("Group")) + '</option></select>' +
                    '<input type="text" class="form-control" id="' + uid + '-name" list="' + uid + '-list" autocomplete="off">' +
                    '<datalist id="' + uid + '-list"></datalist>' +
                    '<select class="form-control" id="' + uid + '-role" aria-label="' + esc(gt("Role")) + '">' +
                    Object.keys(ROLES).map(function(k){ return '<option value="' + k + '"' + (k === role ? " selected" : "") + '>' + esc(ROLES[k]) + '</option>'; }).join("") +
                    '</select><button type="button" class="btn btn-default" id="' + uid + '-add"' + (busy ? " disabled" : "") + '><i class="fa fa-plus" aria-hidden="true"></i> ' + esc(gt("Add")) + '</button></div>' +
                    '<div class="checkbox mm-label"><label><input type="checkbox" id="' + uid + '-open"' + (state.open ? " checked" : "") + (busy ? " disabled" : "") + '> ' +
                    esc(gt("Open to everyone")) + '</label>' + MM.tip(gt("Any user can join as a pilot.")) + '</div>';
            }else if (state.open){
                h += '<p class="mm-label">' + esc(gt("Open to everyone")) + ' ' + MM.tip(gt("Any user can join as a pilot.")) + '</p>';
            }
            if (error) h += '<div class="alert alert-warning" role="alert">' + esc(error) + '</div>';
            el.innerHTML = h;
            MM.tips(el);

            Array.prototype.forEach.call(el.querySelectorAll("[data-role]"), function(s){
                s.onchange = function(){
                    var e = state.entries[parseInt(s.getAttribute("data-role"))];
                    run(o.set(e.kind, e.name, s.value));
                };
            });
            Array.prototype.forEach.call(el.querySelectorAll("[data-remove]"), function(b){
                b.onclick = function(){
                    var e = state.entries[parseInt(b.getAttribute("data-remove"))];
                    Promise.resolve(o.beforeRemove ? o.beforeRemove(e) : true).then(function(yes){
                        if (yes) run(o.set(e.kind, e.name, "none"));
                    });
                };
            });
            if (!o.canManage) return;
            var name = document.getElementById(uid + "-name");
            var add = function(){
                var v = name.value.trim();
                if (!v){
                    error = kind === "group" ? gt("Type the name of a group to add.") : gt("Type the username of a person to add.");
                    render();
                    document.getElementById(uid + "-name").focus();
                    return;
                }
                run(o.set(kind, v, role)).then(function(ok){
                    var n = document.getElementById(uid + "-name");
                    if (!ok && n){ n.value = v; }
                    if (n) n.focus();
                });
            };
            document.getElementById(uid + "-kind").onchange = function(){ kind = this.value; suggest(name.value.trim()); };
            document.getElementById(uid + "-role").onchange = function(){ role = this.value; };
            name.oninput = function(){ suggest(name.value.trim()); };
            name.onkeydown = function(ev){ if (ev.key === "Enter"){ ev.preventDefault(); add(); } };
            document.getElementById(uid + "-add").onclick = add;
            document.getElementById(uid + "-open").onchange = function(){ run(o.setOpen(this.checked)); };
        };

        return {
            update: function(s){ state = s; render(); },
            state: function(){ return state; }
        };
    };

    MM.geocoder = function(map){
        var esc = MM.esc, results = [], active = -1, timer = null, ctrl = null, seq = 0;
        var Control = L.Control.extend({
            options: { position: "topright" },
            onAdd: function(){
                var div = L.DomUtil.create("div", "mm-geo");
                div.innerHTML = '<input type="search" class="form-control input-sm" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="mm-geo-list" ' +
                    'aria-label="' + esc(gt("Search for a place")) + '" placeholder="' + esc(gt("Search for a place")) + '" autocomplete="off">' +
                    '<ul class="dropdown-menu dropdown-menu-right" id="mm-geo-list" role="listbox"></ul>';
                L.DomEvent.disableClickPropagation(div);
                L.DomEvent.disableScrollPropagation(div);
                return div;
            }
        });
        var c = new Control();
        c.addTo(map);
        map.attributionControl.addAttribution('<a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>');
        var div = c.getContainer();
        var input = div.querySelector("input");
        var list = div.querySelector("ul");

        var describe = function(p){
            var street = [p.street, p.housenumber].filter(Boolean).join(" ");
            var title = p.name || street || p.city || p.state || p.country || "";
            var parts = [];
            [street, p.district, p.city || p.town || p.village, p.county, p.state, p.country].forEach(function(x){
                if (x && x !== title && parts.indexOf(x) === -1) parts.push(x);
            });
            return { title: title, detail: parts.join(", ") };
        };

        var fit = function(){
            var w = Math.max(140, Math.min(300, map.getSize().x - 150));
            input.style.width = w + "px";
            list.style.width = w + "px";
            var layers = map.getContainer().querySelector(".leaflet-control-layers");
            if (layers && layers.offsetHeight) input.style.height = layers.offsetHeight + "px";
            var room = map.getContainer().getBoundingClientRect().bottom - input.getBoundingClientRect().bottom - 30;
            list.style.maxHeight = Math.max(80, room) + "px";
        };
        map.on("resize", fit);

        var show = function(items, note){
            results = items;
            active = -1;
            if (!items.length && !note){
                list.style.display = "none";
                input.setAttribute("aria-expanded", "false");
                return;
            }
            list.innerHTML = items.length ? items.map(function(r, i){
                return '<li role="option" id="mm-geo-' + i + '"><a href="#" tabindex="-1" data-i="' + i + '"><span class="mm-geo-title">' + esc(r.title) + '</span>' +
                    (r.detail ? '<span class="mm-geo-detail text-muted">' + esc(r.detail) + '</span>' : '') + '</a></li>';
            }).join("") : '<li class="disabled"><a href="#" tabindex="-1"><span class="mm-geo-detail">' + esc(note) + '</span></a></li>';
            list.style.display = "block";
            fit();
            input.setAttribute("aria-expanded", "true");
            Array.prototype.forEach.call(list.querySelectorAll("[data-i]"), function(a){
                a.onmousedown = function(e){ e.preventDefault(); };
                a.onclick = function(e){ e.preventDefault(); go(parseInt(a.getAttribute("data-i"))); };
            });
        };

        var highlight = function(i){
            active = i;
            Array.prototype.forEach.call(list.children, function(li, j){
                var a = li.querySelector("a");
                if (a) a.className = j === i ? "theme-background-highlight" : "";
                if (j === i) li.scrollIntoView({ block: "nearest" });
            });
            if (i >= 0) input.setAttribute("aria-activedescendant", "mm-geo-" + i);
            else input.removeAttribute("aria-activedescendant");
        };

        var go = function(i){
            var r = results[i];
            if (!r) return;
            if (r.bounds) map.fitBounds(r.bounds, { maxZoom: 18 });
            else map.setView(r.latlng, 17);
            input.value = r.title;
            show([]);
        };

        var search = function(q){
            clearTimeout(timer);
            if (ctrl) ctrl.abort();
            var coords = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (coords){
                var lat = parseFloat(coords[1]), lon = parseFloat(coords[2]);
                if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180){
                    show([{ title: MM.f("Go to %(lat)s, %(lon)s", {lat: lat, lon: lon}), detail: "", latlng: [lat, lon] }]);
                    return;
                }
            }
            if (q.length < 3){ show([]); return; }
            timer = setTimeout(function(){
                var s = ++seq, center = map.getCenter();
                ctrl = window.AbortController ? new AbortController() : null;
                var url = "https://photon.komoot.io/api/?limit=8&q=" + encodeURIComponent(q);
                if (map.getZoom() >= 5) url += "&lat=" + center.lat.toFixed(4) + "&lon=" + center.lng.toFixed(4);
                fetch(url, ctrl ? { signal: ctrl.signal } : {}).then(function(r){
                    if (!r.ok) throw new Error();
                    return r.json();
                }).then(function(j){
                    if (s !== seq) return;
                    var seen = {}, items = [];
                    (j.features || []).forEach(function(f){
                        var d = describe(f.properties), key = d.title + "|" + d.detail, e = f.properties.extent;
                        if (!d.title || seen[key]) return;
                        seen[key] = true;
                        items.push({
                            title: d.title,
                            detail: d.detail,
                            latlng: [f.geometry.coordinates[1], f.geometry.coordinates[0]],
                            bounds: e ? [[e[3], e[0]], [e[1], e[2]]] : null
                        });
                    });
                    show(items, items.length ? null : gt("No places found. Try a different spelling or a nearby town."));
                }).catch(function(e){
                    if (s !== seq || (e && e.name === "AbortError")) return;
                    show([], gt("Unable to search places right now. Check the connection and try again."));
                });
            }, 350);
        };

        fit();
        input.addEventListener("input", function(){ search(input.value.trim()); });
        input.addEventListener("keydown", function(e){
            e.stopPropagation();
            if (e.key === "ArrowDown" && results.length){ e.preventDefault(); highlight((active + 1) % results.length); }
            else if (e.key === "ArrowUp" && results.length){ e.preventDefault(); highlight((active - 1 + results.length) % results.length); }
            else if (e.key === "Enter"){ e.preventDefault(); go(active >= 0 ? active : 0); }
            else if (e.key === "Escape"){ show([]); }
        });
        input.addEventListener("blur", function(){ setTimeout(function(){ show([]); }, 150); });
        input.addEventListener("focus", function(){ if (results.length) show(results); });
        return c;
    };
})();
