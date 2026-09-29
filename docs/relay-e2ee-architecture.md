# PromptX E2EE Relay 协议 v3

## 访问方式与信任边界

手机通过 WSS 连接公网 Relay，Relay 将帧转发到本机 Daemon 的出站连接。本机解密后访问 loopback 的 `/api/v2/*`，沿用原有业务接口。无需账号，但必须持有完整配对链接中的配对秘密。

**端到端加密保护的是转发链路，前提是 Web 客户端代码可信。** 当前 Web 静态资源也由 Relay 站点提供；如果该站点或发布链被攻陷，攻击者可以替换 JavaScript、读取配对秘密和解密后的内容。因此不能宣称“公网服务器完全失陷后仍无法读取业务”。对这一威胁需要独立分发、可验证的客户端，而不只是修改加密协议。TLS/WSS、发布权限和静态资源完整性仍是信任边界的一部分。

## 身份与配对

身份仍保存在 `~/.promptx/data/relay-identity-v2.json`，内部版本为 `3`，文件权限 `0600`。包括：

- Curve25519 公私钥，用于数据通道密钥协商。
- Ed25519 公私钥，用于证明控制与数据连接的 Daemon 身份。
- 32 字节随机 `pairingKeyB64`，用于授权浏览器访问。
- `serverId` 等于 `srv_` 加 Ed25519 公钥的无填充 Base64URL 编码。

配对链接为 `https://<可信客户端站点>/#offer=<base64url-json>`，Offer 包含版本、serverId、Daemon 公钥、配对秘密与 Relay 地址。URL Fragment 不进入普通 HTTP 请求，但网页脚本能够读取；完整链接等同远程访问凭证，禁止公开分享或记录到公网日志。

新安装默认关闭 Relay；已有显式配置保留。读取设置不返回配对秘密；用户启用后，点击“显示配对链接”调用 `POST /api/v2/relay/pairing`（`Cache-Control: no-store`）。禁用时不返回链接。重置身份会同时替换所有密钥，使旧链接失效。

协议 v3 不降级兼容 v2。本机、Web 与 Relay 需要同步升级并重新配对；旧身份文件在首次加载时升级为新的 v3 身份，不迁移旧秘密。会话数据库不受影响。

## Relay 连接认证

所有 WebSocket 地址使用 `v=3`：

- 浏览器：`role=client&serverId=...`
- Daemon 控制：`role=server&serverId=...`
- Daemon 数据：`role=server&serverId=...&connectionId=...`

控制和数据连接在注册之前都必须认证：Relay 发出新的随机 `relay.challenge`，Daemon 返回 Ed25519 签名。签名绑定域分隔标记、版本、serverId、connectionId 和挑战。Relay 验证公钥对应的 serverId 和签名，通过后才注册或替换连接；10 秒未认证关闭。路由 ID 本身不再具有控制连接的接管权限。

认证后的控制连接只交换 ready、sync、connected、disconnected 和心跳信息。Relay 不持有身份私钥、配对秘密或会话密钥。

## 数据通道认证与加密

1. 浏览器生成临时 Curve25519 密钥对、32 字节随机 clientNonce，发送 `e2ee.hello`（v3、公钥、clientNonce、支持的压缩编码）。
2. Daemon 生成新的 32 字节挑战，发送 `e2ee.challenge`。双方检查原始 Curve25519 共享值，拒绝全零结果对应的低阶公钥。
3. 双方将 NaCl `box.before` 共享值与配对秘密拼接为 HKDF 输入；以握手 transcript 的 SHA-256 为 salt，使用 HKDF-SHA-256 派生两个方向的独立密钥。transcript 绑定协议域、版本、serverId、客户端公钥、clientNonce、Daemon 挑战和编码协商。
4. 浏览器发送加密 `e2ee.auth`；Daemon 成功认证后返回加密 `e2ee.ready`。15 秒内未完成认证则关闭，认证前不转发业务请求。
5. 业务帧使用 NaCl XSalsa20-Poly1305，包格式是 24 字节随机 nonce 加认证密文。每个方向的密文内部包含严格连续递增的序号，从 1 开始。拒绝重放、乱序、方向反射与其他会话的旧密文。

静态 Daemon DH 私钥与配对秘密若同时泄露，录制过的旧握手和流量不具备前向保密保证；本方案没有宣称前向保密。

## HTTP、SSE 与取消

请求按 `request.start`、`request.body`、`request.end` 分帧；响应按 `response.start`、`response.body`、`response.end` 返回。正文 chunk 使用 Base64。可协商 gzip，SSE 不压缩。转发剥离 Host、Origin、Cookie、Authorization 等头，目标固定为本机 V2 API。

每个请求依次进入接收、转发、结束状态。同一数据连接内，一个 requestId 只接受一次；重复 end 不重复执行写操作。`request.cancel`、浏览器流取消、超时或连接断开会中止本机请求并清理计时器与缓冲。浏览器忽略已取消请求的迟到响应，仍保持会话序号校验。

资源限制：

- WebSocket 单帧 512 KiB；每个数据连接最多 64 个活动请求。
- 请求正文及接收阶段的连接总缓冲上限 64 MiB；上传发送端等待 WebSocket 缓冲下降。
- 接收及等待本机响应头限时 30 秒；响应阶段限时 10 分钟，SSE 到期由客户端恢复订阅。
- 公网转发队列默认 1 MiB，慢端暂停来源读取，超过上限关闭连接。
- 浏览器未消费的单个响应缓冲上限 4 MiB；超限取消该请求。
- 本地 SSE 写缓冲上限 4 MiB，慢客户端断开后可用游标恢复。
- 请求 ID 去重集合最多 100,000 项，超过后关闭连接并重新建立会话。
- Relay 的连接限流使用真实 socket 来源地址，不信任任意客户端提交的 X-Forwarded-For。反向代理后该地址通常为代理 IP，因此限额是该代理出口的共享额度，需要按容量配置。

操作与部署步骤见 [快速上手](./relay-quickstart.md)。
