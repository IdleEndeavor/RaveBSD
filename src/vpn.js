// Gluetun's control server: is the tunnel up, which exit and public IP, the forwarded port, switching exit.
// RaveBSD cannot route itself through Gluetun (that is network_mode in compose). When "Send everything
// through Gluetun" is on, RaveBSD checks the tunnel every minute and, if it drops and "Stop if the tunnel
// drops" is on, pauses searching and downloading until it is back.
import { settings } from './config.js';

export const vpn = { up: null, checkedAt: 0, ip: '', country: '', city: '', region: '', org: '', port: 0, error: '' };
let onChange = () => {};
export const onVpnChange = fn => { onChange = fn; };

async function call(p, init = {}) {
    const url = String(settings.vpn.controlUrl || '').replace(/\/+$/, '');
    if (!url) throw new Error('No control server address set');
    const res = await fetch(url + p, {
        ...init,
        headers: { ...(settings.vpn.apiKey ? { 'X-API-Key': settings.vpn.apiKey } : {}), ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401) throw new Error(settings.vpn.apiKey ? 'The control server refused the API key' : 'The control server wants an API key');
    if (!res.ok) throw new Error('The control server answered ' + res.status);
    return res.json().catch(() => ({}));
}

export async function checkVpn() {
    const was = vpn.up;
    try {
        const st = await call('/v1/vpn/status');
        vpn.up = st.status === 'running';
        const ip = await call('/v1/publicip/ip').catch(() => ({}));
        vpn.ip = ip.public_ip || ''; vpn.country = ip.country || ''; vpn.city = ip.city || ''; vpn.region = ip.region || ''; vpn.org = ip.organization || '';
        // Newer Gluetun uses /v1/portforward, older /v1/openvpn/portforwarded.
        const pf = await call('/v1/portforward').catch(() => call('/v1/openvpn/portforwarded').catch(() => ({})));
        vpn.port = Number(pf.port) || 0;
        vpn.error = vpn.up ? '' : 'The tunnel is ' + (st.status || 'down');
        if (vpn.up && !vpn.ip) { vpn.up = false; vpn.error = 'No public IP yet'; }
    } catch (e) {
        vpn.up = false;
        vpn.error = e.cause && e.cause.code ? 'Could not reach the control server' : e.message;
    }
    vpn.checkedAt = Date.now();
    if (was !== vpn.up) onChange(vpn);
    return vpn;
}

// Asks Gluetun for a new exit by restarting the VPN (it picks a server again from its own settings).
export async function switchExit() {
    await call('/v1/vpn/status', { method: 'PUT', body: JSON.stringify({ status: 'stopped' }) });
    await call('/v1/vpn/status', { method: 'PUT', body: JSON.stringify({ status: 'running' }) });
    await new Promise(r => setTimeout(r, 3000));
    return checkVpn();
}

// Searches and downloads stop only when the owner asked for it and the tunnel is known to be down.
export const vpnBlocks = () => settings.vpn.enabled && settings.vpn.stopOnDrop && vpn.up === false;

setInterval(() => { if (settings.vpn.enabled) checkVpn(); }, 60e3).unref();
