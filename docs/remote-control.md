# Remote control

[Documentation](README.md) · [Project home](../README.md) · [简体中文](remote-control.zh-CN.md)

After a remote connection recovers, cached conversations reload their messages, including replies and questions received while offline. Streamed updates arriving during the reload are preserved. MCP and Skill creation also works over the default HTTP LAN link. Remote service changes are applied in order, so changing ports and then disabling remote control closes the previous listeners.

Turn the switch on under Remote control in Settings. The app listens on the LAN (port `8765` by default) and serves the same UI as the desktop app. A phone or another computer on the same network can open it by scanning the QR code. The QR code includes the project or conversation currently open on the computer. If the computer has more than one network interface, pick another address from the dropdown.

Turn on public access and the app opens a reverse tunnel with the local OpenSSH client. A gateway on the server owns the public port (default `8765`) and forwards each request to the computer named in the link. Several computers can share that one port at the same time. Each link is different, for example `http://43.167.166.239:8765/c/<computer-id>/?token=...`. The id is created the first time it is needed and stored on this machine. Resetting the link does not change it. The default server is `root@43.167.166.239`. The SSH user, server address, and public port can all be changed. Set up your own server with the steps below before using it. Once the tunnel is up, the public link appears in the address dropdown and in the QR code. Changing the address or port reconnects. After a drop, it retries at 1, 2, 5, and 10 seconds.

- The link carries an access token. The phone remembers it after the first open. In the same browser, public tokens for different computers are stored separately. Anyone with the link can fully control this app (send tasks, change settings), so do not share it. Reset link issues a new token. Old LAN and public links, and phones already connected, stop working immediately.
- Remote settings responses and state updates redact Cursor, Codex, and Claude API keys and the access token. Saving blank key fields from the phone preserves the keys configured on the desktop. The phone cannot change remote-control settings. Buttons that only make sense on the computer, such as Open in Cursor and Open in file manager, are hidden. Adding a project requires typing a path on the computer by hand.
- The server is HTTP only. There is no encryption. Use the LAN only on a network you trust. A public link is plaintext on the path and on this server, so enable it only on a server you control. The first time you enable it, Windows Firewall may prompt you; allow access on private networks.
- The public tunnel uses the machine’s default SSH key and logs in with `BatchMode`, so it never asks for a password. Each computer connects the tunnel to a Unix socket on the server, `/run/agent-desktop/<computer-id>`, and does not bind the public port itself. The server must allow socket forwarding (`AllowStreamLocalForwarding yes`) and set `StreamLocalBindUnlink yes`. Otherwise a socket file left behind after a disconnect blocks the next connection. The gateway listens on the public port and forwards the page. Open that public port in the cloud security group. The app does not change the server while it is running.
- At a screen width of 720px or less, the sidebar becomes a drawer, and the changes panel and Settings become full screen. Settings categories switch in a horizontal bar at the top.
- In development, page requests are forwarded to the Vite dev server, and only to that one address. An absolute URL in the request line is not followed. Hot reload does not go through the proxy; refresh the phone by hand after a change.

If the gateway is temporarily unreachable while SSH remains connected, health checks continue with retry backoff and restore the public link when the gateway becomes reachable. Health responses from a previous SSH connection are ignored after reconnecting, and stopping public access cancels further retries.

## Set up your own public server

From the project directory, one command logs into your Linux server over SSH, writes the sshd settings the tunnel needs, and installs the shared-port gateway:

```bash
npm run setup:public-server -- --user root --host your-server --port 8765
```

`--user` is the SSH user. `--host` is a domain or IP. `--port` is the public port the phone opens. Add `--ssh-port` when SSH listens somewhere other than 22. See every flag with `npm run setup:public-server -- --help`.

The script uses a passphrase-less default key: `~/.ssh/id_rsa`, `id_ecdsa`, or `id_ed25519`. If none exists, it generates `~/.ssh/id_ed25519`. If that public key cannot log in yet, the terminal asks for the SSH password once and writes the key into that user’s `authorized_keys`. If the server only accepts a different private key, point `--identity` at it. The script still installs the default public key, because the app opens the tunnel with the default key only. A non-root user must be able to `sudo`; enter the password when prompted. If the server has no `python3`, the script installs it with apt, dnf, yum, or apk.

The script backs up `sshd_config` first. If `sshd -t` fails, it restores the backup, then `reload`s sshd without dropping the current login. With systemd, the gateway runs as a service on the public port you chose. Without systemd, it runs in the background. If firewalld or ufw is running, that port is opened. Older builds bound the public port themselves. Before upgrading, turn public access off on those clients, then run this script.

When the command succeeds, enter the same SSH user, server address, SSH port (default `22`), and public port under Remote control, then turn on remote control and public access. The SSH port must match `--ssh-port`; it is separate from the public web port. Open the public port in the cloud security group.

With no arguments, the script configures port `8765` on the default server `root@43.167.166.239`. If you are already logged into the server and `public-gateway.py` is next to the script, you can also run `sudo bash scripts/setup-public-server.sh 8765`.
