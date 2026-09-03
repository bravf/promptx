# PromptX V2 E2EE Relay 架构

## 1. 目标

PromptX Relay 用来让手机或其他浏览器在不开放本机端口的情况下访问本机 daemon。

V2 Relay 必须满足：

- 任意安装 PromptX 的用户都可以连接公共 Relay，不需要账号、`accessToken` 或 `deviceToken`。
- 手机与 daemon 端到端加密，Relay 不能读取 Prompt、回复、Timeline、代码、Diff、图片和附件。
- daemon 继续复用本机 Fastify `/api/v2/*` 接口，Agent、Timeline、数据库和权限语义不因 Relay 改造而改变。
- 本机和公网使用同一份 Vue 构建产物，仅底层 Transport 不同。
- daemon 只建立出站连接，不要求公网 IP、端口映射或内网穿透配置。

## 2. 角色与信任边界

```text
手机浏览器 / PromptX Web
        │
        │ WSS + E2EE 密文
        ▼
公网 PromptX Relay
        │
        │ WSS + E2EE 密文
        ▼
本机 PromptX daemon
        │
        │ loopback HTTP / SSE
        ▼
Fastify API、Agent Provider、工作区和本地数据库
```

### Web 客户端

- 从配对链接读取 Offer。
- 每次数据连接生成临时 Curve25519 密钥对。
- 建立加密通道后，把 HTTP 请求和流式订阅封装为 Relay 帧。
- 收到文件或图片后在浏览器内生成 Blob URL。

### daemon

- 首次启动生成并持久保存 Curve25519 身份密钥对。
- 主动维持一条 Relay 控制连接。
- 每个 Web 客户端使用一条独立数据连接和独立共享密钥。
- 解密远程请求，并转发到本机 Fastify API。

### Relay

- 提供同一份 Vue 静态构建。
- 按 `serverId + connectionId` 配对 WebSocket。
- 转发文本或二进制帧，不解析加密后的业务数据。
- 负责连接数、帧大小、频率、心跳和空闲超时等资源保护。

Relay 被视为不可信基础设施。TLS/WSS 仍然必须保留，用于保护网络元数据和连接完整性；E2EE 是 TLS 之上的业务加密层。

## 3. daemon 身份

首次启动时在 PromptX 数据目录创建：

```text
~/.promptx/data/relay-identity-v2.json
```

结构：

```json
{
  "v": 2,
  "serverId": "srv_<高熵随机值>",
  "publicKeyB64": "<32-byte Curve25519 public key>",
  "secretKeyB64": "<32-byte Curve25519 secret key>",
  "createdAt": "2026-09-03T00:00:00.000Z"
}
```

要求：

- 文件权限为 `0600`。
- 私钥永不上传到 Relay，也不进入 Offer。
- 普通重启复用同一身份。
- “重置远程身份”会生成新密钥与新 `serverId`，旧配对链接立即失效。

## 4. Offer 配对链接

daemon 生成：

```text
https://px.mushayu.com/#offer=<base64url-json>
```

Offer 固定结构：

```json
{
  "v": 2,
  "serverId": "srv_xxx",
  "daemonPublicKeyB64": "xxx",
  "relay": {
    "url": "wss://px.mushayu.com/relay/ws"
  }
}
```

`#offer=` 是 URL Fragment，不会进入普通 HTTP 请求、反向代理日志或 Referer。Vue 加载后通过 `location.hash` 读取并保存到 IndexedDB 或 localStorage，然后清理地址栏 Fragment。

Offer 不是密文。它是配对信任锚，完整链接等同远程访问凭证，应像密码一样保护。

## 5. Relay 连接模型

### 5.1 daemon 控制连接

daemon 长期连接：

```text
wss://px.mushayu.com/relay/ws?v=2&role=server&serverId=<serverId>
```

控制连接只传递路由和保活消息：

```json
{ "type": "relay.ready" }
{ "type": "relay.sync", "connectionIds": ["conn_xxx"] }
{ "type": "relay.connected", "connectionId": "conn_xxx" }
{ "type": "relay.disconnected", "connectionId": "conn_xxx" }
{ "type": "relay.ping" }
{ "type": "relay.pong" }
```

### 5.2 Web 客户端连接

客户端连接：

```text
wss://px.mushayu.com/relay/ws?v=2&role=client&serverId=<serverId>
```

Relay 分配随机 `connectionId`，并通知 daemon 控制连接。

### 5.3 daemon 数据连接

daemon 收到 `relay.connected` 后建立对应数据连接：

```text
wss://px.mushayu.com/relay/ws?v=2&role=server&serverId=<serverId>&connectionId=<connectionId>
```

Relay 此后只做双向映射：

```text
client(serverId, connectionId) <-> daemon(serverId, connectionId)
```

每个浏览器连接相互隔离，不共享 E2EE 会话密钥。

## 6. E2EE 握手

1. 客户端从 Offer 得到 daemon 公钥。
2. 客户端为本次连接生成临时 Curve25519 密钥对。
3. 客户端计算 `sharedKey = ECDH(clientSecretKey, daemonPublicKey)`。
4. 客户端发送明文握手：

```json
{
  "type": "e2ee.hello",
  "clientPublicKeyB64": "xxx"
}
```

5. daemon 计算 `sharedKey = ECDH(daemonSecretKey, clientPublicKey)`。
6. daemon 返回明文确认：

```json
{
  "type": "e2ee.ready",
  "v": 2
}
```

7. 双方只接受加密业务帧。

双方使用 NaCl `box.before/after`，底层为 Curve25519 密钥交换与 XSalsa20-Poly1305 认证加密。

二进制包格式：

```text
[24-byte random nonce][authenticated ciphertext]
```

明文首字节标记原消息类型：

```text
0x01 = UTF-8 JSON/text
0x02 = binary
```

接收端记录当前连接已见 nonce，拒绝同一连接内的重复帧。新连接使用新的客户端临时密钥，因此旧连接密文也不能跨连接复用。

## 7. 加密 HTTP 隧道

Web 客户端不直接向公网 Relay 发业务 HTTP 请求，而是把 HTTP 语义封装后加密：

```json
{ "type": "request.start", "requestId": "req_xxx", "method": "POST", "path": "/api/v2/agents/a/turns", "headers": {} }
{ "type": "request.body", "requestId": "req_xxx", "chunk": "<base64>" }
{ "type": "request.end", "requestId": "req_xxx" }
```

daemon 解密并请求本机：

```text
http://127.0.0.1:<daemon-port>/api/v2/agents/a/turns
```

响应同样分帧并加密：

```json
{ "type": "response.start", "requestId": "req_xxx", "status": 200, "headers": {} }
{ "type": "response.body", "requestId": "req_xxx", "chunk": "<base64>" }
{ "type": "response.end", "requestId": "req_xxx" }
```

取消请求：

```json
{ "type": "request.cancel", "requestId": "req_xxx" }
```

协议限制：

- 单个明文 chunk 最大 256 KiB。
- Relay 单个 WebSocket 帧设置独立上限。
- daemon 只允许转发到自身 loopback 基地址。
- hop-by-hop header、Cookie 和 Host 不进入隧道。

## 8. Timeline、文件与附件

### Timeline

daemon 内部继续使用 SSE。远程 Transport 逐块读取 SSE 响应，把解密后的 `response.body` 交给浏览器端 SSE 解析器，因此 Timeline 仍然实时更新。

### 上传

浏览器生成 multipart body，再通过 `request.body` 分块加密发送。Relay 只能看到密文帧大小。

### 图片、文件和 Diff

- JSON 文件预览和 Diff 使用普通加密请求。
- 二进制内容通过加密请求获取，在浏览器生成 Blob URL。
- 远程模式禁止组件直接使用公网 `/api/v2/*` 作为 `img/src`、`audio/src` 或下载链接。
- 组件卸载或资源替换时必须撤销 Blob URL。

只有这些资源全部走加密 Transport 后，PromptX 才能宣称 Relay 看不到代码和文件。

## 9. 一套 Vue、两种 Transport

本机 daemon 和公网 Relay 提供相同的 `apps/web/dist`：

```text
LocalHttpTransport
  fetch + EventSource + 普通资源 URL

EncryptedRelayTransport
  E2EE WebSocket request + stream + Blob URL
```

运行时选择：

- loopback 地址默认使用 `LocalHttpTransport`。
- 存在有效 `#offer=` 时保存 Offer 并进入远程模式。
- 公网地址无 Fragment 时尝试恢复本机已保存的 Offer。

Vue 页面、工作区、Agent、Timeline、输入框、文件和 Diff 组件全部共用。

## 10. 无账号公共 Relay

PromptX Relay 不维护用户、租户和业务权限：

- 不需要注册或登录。
- 不使用 `accessToken`。
- 不使用 `deviceToken`。
- `serverId` 只用于路由，不代表 Relay 授权。
- 持有完整 Offer 的客户端被视为 daemon 的可信操作者。

公共 Relay 仍需要基础设施级保护：

- IP 连接速率限制。
- 每个 `serverId` 的客户端并发限制。
- 全局连接数限制。
- 最大帧大小与待转发缓冲上限。
- 空闲连接和握手超时。
- daemon 控制连接心跳及指数退避重连。

这些限制只防止滥用，不参与业务解密或用户认证。

## 11. Relay 可见性

Relay 可以看到：

- 客户端与 daemon IP。
- `serverId`、`connectionId`。
- 连接时间、断线时间、包大小和包频率。
- 明文 `e2ee.hello/e2ee.ready` 中的公开握手信息。

Relay不能看到：

- Prompt、回复和思考过程。
- Timeline 事件内容。
- 工作区路径、文件名、源代码和 Diff。
- 图片、附件和下载内容。
- daemon 私钥、客户端临时私钥和共享密钥。

恶意 Relay 可以丢包、延迟、断开连接或造成拒绝服务，但不能在不被发现的情况下读取或篡改业务内容。

## 12. 断线与错误处理

- daemon 控制连接使用指数退避重连，上限 30 秒。
- 控制连接恢复后，Relay 下发当前客户端 `connectionId` 全量同步。
- Web 数据连接断开后自动重连并重新执行 E2EE 握手。
- 普通请求断线时立即失败，不静默重放写请求。
- Timeline 等只读长连接在新通道建立后自动重新订阅。
- 错误密钥、认证解密失败、非法首帧和重复 nonce 立即关闭数据连接。

## 13. 部署

```text
https://px.mushayu.com/
  -> 同一份 Vue 静态资源

wss://px.mushayu.com/relay/ws
  -> 不透明 WebSocket Relay

https://px.mushayu.com/health
  -> Relay 自身健康检查，不包含业务数据
```

Nginx 负责 TLS 和 WebSocket Upgrade，Node/Fastify Relay 只监听云服务器 loopback 端口。

## 14. 明确不做

- Relay 不保存聊天、代码、Timeline 或附件。
- Relay 不代理 `/api/v2/*` 明文 HTTP。
- Relay 不运行 Agent Provider。
- Relay 不持有 daemon 私钥。
- V2 不兼容旧的租户域名、Cookie 登录和 Token Relay 协议。
