// ==UserScript==
// @name         FanFilm
// @namespace    http://tampermonkey.net/
// @version      0.1.20260409.0
// @description  Web service
// @author       kpl-team
// @match        http*://cda-hd.cc/*
// @match        http*://zaluknij.cc/*
// @icon         https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm/refs/heads/main/favicon.png
// @downloadURL  https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm/refs/heads/main/fanfilm.user.js
// @updateURL    https://raw.githubusercontent.com/fanfilm-pl/repository.fanfilm/refs/heads/main/fanfilm.user.js
// @grant        GM.xmlHttpRequest
// @grant        GM.cookie
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

const fanfilmDefaultPort = 8663;
var fanfilmRoot;
var fanfilmMessageTimer = null;
var fanfilmSendTimer = null;
const fanfilmMessageHideInterval = 4000;
const fanfilmUpdateInterval = 5000;

// Zmienne do śledzenia statusu wysyłania
var fanfilmSendResults = {};
var fanfilmTotalHosts = 0;

function sleep(ms)
{
    return new Promise(resolve => setTimeout(resolve, ms));
}

function hasClass(element, className)
{
    return (' ' + element.className + ' ').indexOf(' ' + className+ ' ') > -1;
}

function toHash(data)
{
    if (!(typeof data === 'string' || data instanceof String)) {
        data = JSON.stringify(data);
    }
    return data.split('').reduce((hash, char) => {
        return char.charCodeAt(0) + (hash << 6) + (hash << 16) - hash;
    }, 0);
}

function fanfilmRawHosts()
{
    return GM_getValue("ff_target_hosts", ['127.0.0.1']);
}

function fanfilmHostsString()
{
    return fanfilmRawHosts().join(', ');
}

function fanfilmHosts()
{
    let hosts = [];
    for (let host of fanfilmRawHosts()) {
        if (!host.includes(":")) {
            host = `${host}:${fanfilmDefaultPort}`
        }
        hosts.push(host);
    }
    return hosts;
}

function fanfilmSaveHosts()
{
    const ffInput = fanfilmRoot.getElementById("ff-ip");
    let hosts = [];
    for (const host of ffInput.value.split(',')) {
        hosts.push(host.trim());
    }
    GM_setValue("ff_target_hosts", hosts);
}

function fanfilmMessage(cls, msg)
{
    const ffStatus = fanfilmRoot.getElementById("ff-status");
    // Set message and class (type)
    ffStatus.textContent = msg;
    ffStatus.className = cls || '';
    // Clear active message timer
    if (fanfilmMessageTimer) {
        clearTimeout(fanfilmMessageTimer);
    }
    // Set new timer to clear message (after 4 sec)
    fanfilmMessageTimer = setTimeout(() => {
        ffStatus.textContent = '';
        ffStatus.className = '';
    }, fanfilmMessageHideInterval);
}

function fanfilmUpdateStatus() {
    const completed = Object.keys(fanfilmSendResults).length;

    if (completed < fanfilmTotalHosts) {
        return;
    }

    const successes = Object.values(fanfilmSendResults).filter(result => result === 'success').length;
    const errors = Object.values(fanfilmSendResults).filter(result => result === 'error').length;

    if (successes > 0 && errors === 0) {
        fanfilmMessage('success', '✅ Wysłano');
    } else if (errors > 0 && successes === 0) {
        fanfilmMessage('error', '❌ Błąd wysyłania!');
    } else {
        fanfilmMessage('partial', `⚠️ Wysłano: ${successes}/${fanfilmTotalHosts}`);
    }

    fanfilmSendResults = {};
    fanfilmTotalHosts = 0;
}

function fanfilmLoadSites(host) {
    let sites = GM_getValue('ff_sites', {});
    let site = sites[location.hostname]
    if (!site) {
        sites[location.hostname] = site = {
            hosts: {},
        }
    }
    let host_data = null;
    if (host) {
        host_data = site.hosts[host];
        if(!host_data) {
            site.hosts[host] = host_data = {
                timestamp: 0,
                cookies: 0,
                status: '',
            }
        }
    }
    return [sites, site, host_data]
}

async function fanfilmCookies(options)
{
    // Pobranie cookies
    let cookies = await GM.cookie.list({url: location.hostname, partitionKey: {}});
    if (!options) {
        options = {}
    }
    let data = {
        host: location.hostname,
        user_agent: navigator.userAgent,
        cookies: cookies,
    };
    // console.log("[FanFilm] Zebrane dane:", data);
    return data
}

async function fanfilmSendOne(host, options)
{
    if (!options) {
        options = {};
    }
    const cookies = options.cookies ? options.cookies : await fanfilmCookies(options);
    const hash = toHash(cookies);

    let [sites, site, site_host] = fanfilmLoadSites(host);
    site_host.cookies_hash = hash;
    site_host.timestamp = Date.now();
    GM_setValue('ff_sites', sites);

    const interval = fanfilmUpdateInterval;
    if (fanfilmSendTimer) {
        clearTimeout(fanfilmSendTimer);
    }
    if (interval) {
        fanfilmSendTimer = setTimeout(() => {
            fanfilmUpdate();
        }, interval);
    }

    // Post cookies to FanFilm plugin
    let data = { ...cookies, forced_by_user: options.forced_by_user ? true : false};
    console.log(`[FanFilm] Wysyłanie do serwera ${host}:`, data);
    GM.xmlHttpRequest({
        method: "POST",
        url: `http://${host}/cookies`,
        data: JSON.stringify(data),
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
        },
        onload: function(response) {
            try {
                console.log(`[FanFilm] Odpowiedź serwera ${host}:`, JSON.parse(response.responseText));
            } catch(e) {
                console.log(`[FanFilm] Odpowiedź serwera ${host} (raw):`, response.responseText);
            }

            fanfilmSendResults[host] = 'success';
            fanfilmUpdateStatus();

            let [sites, site, site_host] = fanfilmLoadSites(host);
            site_host.status = 'success';
            GM_setValue('ff_sites', sites);
        },
        onerror: function(err) {
            console.error(`Błąd wysyłania do ${host}:`, err);

            fanfilmSendResults[host] = 'error';
            fanfilmUpdateStatus();

            let [sites, site, site_host] = fanfilmLoadSites(host);
            site_host.status = 'error';
            GM_setValue('ff_sites', sites);
        }
    });
}

async function fanfilmSendToAll(options)
{
    if (!options) {
        options = {};
    }
    if (!options.cookies) {
        options.cookies = await fanfilmCookies(options);
    }
    const hosts = fanfilmHosts();
    const ffStatus = fanfilmRoot.getElementById("ff-status");

    // Reset wyników i ustaw liczbę hostów
    fanfilmSendResults = {};
    fanfilmTotalHosts = hosts.length;

    if (hosts.length > 1) {
        ffStatus.textContent = `Status: wysyłanie do ${hosts.length} serwerów...`;
    } else {
        ffStatus.textContent = "Status: wysyłanie...";
    }
    ffStatus.className = "sending";

    for(const host of hosts) {
        fanfilmSendOne(host, options);
    }
}

async function fanfilmUpdate(options)
{
    if (!options) {
        options = {};
    }
    options.data = await fanfilmCookies(options);
    const new_hash = toHash(options.data);
    const [sites, site, host_site] = fanfilmLoadSites();
    let should_send = false;
    for (const host of fanfilmHosts()) {
        const host_site = site.hosts[host];
        if (!host_site || new_hash != host_site.cookies_hash) {
            should_send = true;
            break;
        }
    }
    if (should_send) {
        await fanfilmSendToAll(options);
    }
}

(async function() {
    'use strict';

    // Tworzymy kontener + Shadow DOM
    const container = document.createElement("div");
    document.body.appendChild(container);
    fanfilmRoot = container.attachShadow({ mode: "open" });

    fanfilmRoot.innerHTML = `
      <style>
        #ff-panel {
          position: fixed;
          bottom: 8px;
          right: 8px;
          background: #222;
          color: #fff;
          font-family: Arial, sans-serif;
          font-size: 15px;
          padding: 4px;
          border-radius: 8px;
          border: solid #999 2px;
          box-shadow: 0 0 8px rgba(0,0,0,0.5);
          z-index: 999999;
          width: 150px;
          line-height: 1.4;
        }
        #ff-header {
          font-weight: bold;
          text-align: center;
          margin-bottom: 4px;
          user-select: none; /* nagłówek nigdy się nie zaznacza */
          display: flex;
          align-items: center;
          position: relative;
        }
        #ff-drag-handle {
          position: absolute;
          cursor: move;
          font-size: 1.1em;
          line-height: 1;
          margin-right: 8px;
          color: #888;
          user-select: none;
          touch-action: none;
          min-width: 1.5em;
        }
        #ff-drag-handle:hover {
          color: #eee;
        }
        #ff-body {
          margin: 12px 8px 8px;
        }
        #ff-title {
          flex: 1;
          cursor: pointer;
        }
        label {
          display: block;
          margin-bottom: 2px;
        }
        input {
          all: unset;
          box-sizing: border-box;
          width: 100%;
          padding: 6px;
          margin-bottom: 6px;
          background: #333;
          color: #fff;
          border: 1px solid #555;
          border-radius: 4px;
          font-size: 0.95em;
        }
        button {
          all: unset;
          box-sizing: border-box;
          width: 100%;
          background: #4CAF50;
          text-align: center;
          color: #fff;
          padding: 8px;
          border-radius: 4px;
          font-size: 1em;
          cursor: pointer;
        }
        #ff-status {
          margin-top: 6px;
          font-size: 0.9em;
          text-align: center;
          color: #bbb;
        }
        #ff-panel .info {
          font-size: 85%;
          color: #bbb;
        }
        #ff-status {
            color: #eee;
        }
        #ff-status.sending {
            color: #bbb;
        }
        #ff-status.ok, #ff-status.success {
            color: #4CAF50;
        }
        #ff-status.error {
            color: red;
        }
        #ff-status.partial {
            color: #FFA500;
        }
      </style>
      <div id="ff-panel">
        <div id="ff-header">
          <span id="ff-drag-handle">⋮</span>
          <span id="ff-title">⚙️ FanFilm</span>
        </div>
        <div id="ff-body" style="display:none;">
          <label>IP lub IP:PORT</label>
          <input type="text" id="ff-ip" value="${fanfilmHostsString()}">
          <div class="info" style="margin-bottom:6px;">
            Domyślny port: ${fanfilmDefaultPort}.
          </div>
          <button id="ff-send">Wyślij</button>
          <div id="ff-status"></div>
        </div>
      </div>
    `;

    const ffPanel = fanfilmRoot.getElementById("ff-panel");
    const ffTitle = fanfilmRoot.getElementById("ff-title");
    const ffDragHandle = fanfilmRoot.getElementById("ff-drag-handle");
    const ffBody = fanfilmRoot.getElementById("ff-body");
    const ffInput = fanfilmRoot.getElementById("ff-ip");
    const ffSend = fanfilmRoot.getElementById("ff-send");
    const ffStatus = fanfilmRoot.getElementById("ff-status");

    // Zmienne dla drag&drop
    let isDragging = false, offsetX = 0, offsetY = 0;
    let wasDragged = false; // flaga czy rzeczywiście przeciągano

    // Funkcja pomocnicza do pobierania współrzędnych z różnych typów zdarzeń
    function getEventCoords(e) {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        } else {
            return { x: e.clientX, y: e.clientY };
        }
    }

    // Rozwijanie/zamykanie po kliknięciu w tytuł (tylko jeśli nie przeciągano)
    ffTitle.addEventListener("click", (e) => {
        // Jeśli właśnie skończono przeciąganie, ignoruj kliknięcie
        if (wasDragged) {
            wasDragged = false;
            return;
        }
        ffBody.style.display = (ffBody.style.display === "none") ? "block" : "none";
    });

    // Zwinięcie po kliknięciu poza panelem
    document.addEventListener("click", (e) => {
        if (!container.contains(e.target)) {
            ffBody.style.display = "none";
        }
    });

    // Funkcja rozpoczynania przeciągania
    function startDragging(e) {
        isDragging = true;
        wasDragged = false;

        const coords = getEventCoords(e);
        const rect = ffPanel.getBoundingClientRect();
        offsetX = coords.x - rect.left;
        offsetY = coords.y - rect.top;

        document.body.style.userSelect = "none";
        e.preventDefault();
    }

    // Funkcja przeciągania
    function doDragging(e) {
        if (!isDragging) {
            return;
        }
        wasDragged = true;
        const coords = getEventCoords(e);
        ffPanel.style.left = (coords.x - offsetX) + "px";
        ffPanel.style.top = (coords.y - offsetY) + "px";
        ffPanel.style.right = 'auto';
        ffPanel.style.bottom = 'auto';
        e.preventDefault();
    }

    // Funkcja kończenia przeciągania
    function stopDragging(e) {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.userSelect = "auto";
        if (wasDragged) {
            setTimeout(() => {
                wasDragged = false;
            }, 10);
        }
        e.preventDefault();
    }

    // Obsługa zdarzeń dotykowych
    ffDragHandle.addEventListener("touchstart", startDragging, { passive: false });
    document.addEventListener("touchmove", doDragging, { passive: false });
    document.addEventListener("touchend", stopDragging, { passive: false });
    document.addEventListener("touchcancel", stopDragging, { passive: false });

    // Obsługa zdarzeń myszy (zachowana dla kompatybilności z desktopem)
    ffDragHandle.addEventListener("mousedown", startDragging);
    document.addEventListener("mousemove", doDragging);
    document.addEventListener("mouseup", stopDragging);

    // Obsługa zdarzeń pointer (dla kompatybilności z nowszymi przeglądarkami)
    ffDragHandle.addEventListener("pointerdown", startDragging);
    document.addEventListener("pointermove", doDragging);
    document.addEventListener("pointerup", stopDragging);
    document.addEventListener("pointercancel", stopDragging);

    // Obsługa przycisku "Wyślij"
    ffSend.addEventListener("click", () => {
        fanfilmSaveHosts();
        fanfilmSendToAll({forced_by_user: true});
    });

    ffInput.addEventListener("focusout", (e) => {
        fanfilmSaveHosts();
    });

    // Aktualizacja IP (gdy inna zakładka zmieni)
    setInterval(() => {
        const ffInput = fanfilmRoot.getElementById("ff-ip");
        if (fanfilmRoot.activeElement !== ffInput) {
            ffInput.value = fanfilmHostsString();
        }
    }, 5000);

    await sleep(1000);
    await fanfilmUpdate();
})();
