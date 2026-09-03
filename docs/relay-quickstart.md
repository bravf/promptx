# PromptX E2EE Relay 快速上手

Relay 让手机浏览器通过公网访问本机 PromptX。手机和 daemon 之间使用 Curve25519 + NaCl 端到端加密，公网 Relay 只转发 WebSocket 密文，不需要账号、租户、`accessToken` 或 `deviceToken`。

完整协议与信任边界见 [relay-e2ee-architecture.md](./relay-e2ee-architecture.md)。

## 本机使用

安装并启动 PromptX：

```bash
npm install -g @muyichengshayu/promptx
promptx start
```

打开本机工作台：

```text
http://127.0.0.1:3001
```

进入“设置 -> 远程访问”。PromptX 默认连接：

```text
wss://px.mushayu.com/relay/ws
```

状态变为“已连接”后，可以：

- 用手机扫描二维码；
- 或复制完整配对链接到手机打开。

链接中的 `#offer=` 包含随机 `serverId` 和 daemon 公钥。URL Fragment 不会发送给普通 HTTP 服务，但完整链接仍等同远程访问凭证，不要公开分享。

需要让旧链接失效时，点击“重置远程身份”。PromptX 会生成新的 `serverId` 和 Curve25519 密钥对。

本机身份保存在：

```text
~/.promptx/data/relay-identity-v2.json
```

文件权限为 `0600`，不要复制或上传其中的私钥。

## Relay 运维

Relay 使用同一份 Vue 构建产物，并提供 `/relay/ws` WebSocket 盲转发端点。

源码启动：

```bash
pnpm install
pnpm build
PROMPTX_RELAY_HOST=127.0.0.1 \
PROMPTX_RELAY_PORT=3030 \
node scripts/relay.mjs
```

后台管理：

```bash
promptx relay start
promptx relay status
promptx relay restart
promptx relay stop
```

健康检查：

```bash
curl http://127.0.0.1:3030/health
```

返回示例：

```json
{
  "ok": true,
  "protocolVersion": 2,
  "connectedDaemons": 1,
  "connectedClients": 1
}
```

## px.mushayu.com Nginx 配置

Relay 应只监听服务器 loopback，由 Nginx 终止 TLS：

```nginx
server {
  listen 80;
  server_name px.mushayu.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;
  server_name px.mushayu.com;

  ssl_certificate /etc/letsencrypt/live/px.mushayu.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/px.mushayu.com/privkey.pem;

  location /relay/ws {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }

  location / {
    proxy_pass http://127.0.0.1:3030;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
  }
}
```

然后检查并重载：

```bash
nginx -t
systemctl reload nginx
curl https://px.mushayu.com/health
```

## 可调限制

公网服务可以通过环境变量设置资源上限：

```text
PROMPTX_RELAY_MAX_FRAME_BYTES=524288
PROMPTX_RELAY_MAX_CLIENTS_PER_SERVER=16
PROMPTX_RELAY_MAX_TOTAL_CLIENTS=5000
PROMPTX_RELAY_MAX_PENDING_BYTES=1048576
PROMPTX_RELAY_HEARTBEAT_INTERVAL_MS=25000
PROMPTX_RELAY_IDLE_TIMEOUT_MS=600000
PROMPTX_RELAY_PENDING_TIMEOUT_MS=30000
PROMPTX_RELAY_CONNECTIONS_PER_MINUTE=120
```

这些限制只用于保护 Relay 资源，不会让 Relay 获得解密业务内容的能力。

## 常见问题

### 一直显示“连接中”

依次检查：

```bash
curl http://127.0.0.1:3001/api/v2/relay/status
curl https://px.mushayu.com/health
```

确认 Nginx 已转发 WebSocket Upgrade，并确认本机可以访问 `wss://px.mushayu.com/relay/ws`。

### 手机打开后无法完成 E2EE 握手

通常是配对链接被截断、旧链接已被重置，或代理没有原样转发二进制 WebSocket 帧。重新从设置复制完整链接，避免聊天软件删掉 `#offer=` Fragment。

### Relay 能看到什么

Relay 可以看到连接时间、IP、`serverId`、连接数量和密文大小。它不能读取 Prompt、回复、Timeline、文件名、文件内容、Diff、图片或附件。服务器日志不应记录 WebSocket 帧内容。
