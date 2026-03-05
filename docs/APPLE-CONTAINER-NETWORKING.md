# Apple Container 网络配置 (macOS 26)

Apple Container 的 vmnet 网络需要手动配置才能让容器访问互联网。未配置时，容器可以与宿主机通信，但无法访问外部服务（DNS、HTTPS、API）。

## 快速配置

运行以下两个命令（需要 `sudo`）：

```bash
# 1. 启用 IP 转发，让宿主机路由容器流量
sudo sysctl -w net.inet.ip.forwarding=1

# 2. 启用 NAT，将容器流量通过你的网络接口进行伪装
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **注意：** 将 `en0` 替换为你实际使用的网络接口。可通过以下命令查看：`route get 8.8.8.8 | grep interface`

## 设为持久化配置

以上设置在重启后会失效。如需永久生效：

**IP 转发** — 添加到 `/etc/sysctl.conf`：
```
net.inet.ip.forwarding=1
```

**NAT 规则** — 添加到 `/etc/pf.conf`（放在现有规则之前）：
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

然后重新加载：`sudo pfctl -f /etc/pf.conf`

## IPv6 DNS 问题

默认情况下，DNS 解析器会优先返回 IPv6（AAAA）记录而非 IPv4（A）记录。由于我们的 NAT 只处理 IPv4，容器内的 Node.js 应用会先尝试 IPv6 并失败。

容器镜像和运行器通过以下方式强制使用 IPv4 优先：
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

该配置同时在 `Dockerfile` 和 `container-runner.ts` 中通过 `-e` 标志设置。

## 验证

```bash
# 检查 IP 转发是否已启用
sysctl net.inet.ip.forwarding
# 预期输出：net.inet.ip.forwarding: 1

# 测试容器的互联网访问
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 预期输出：404

# 检查桥接接口（仅在容器运行时存在）
ifconfig bridge100
```

## 故障排除

| 症状 | 原因 | 修复方法 |
|------|------|----------|
| `curl: (28) Connection timed out` | IP 转发未启用 | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP 正常，HTTPS 超时 | IPv6 DNS 解析 | 添加 `NODE_OPTIONS=--dns-result-order=ipv4first` |
| `Could not resolve host` | DNS 未转发 | 检查 bridge100 是否存在，验证 pfctl NAT 规则 |
| 容器输出后挂起 | agent-runner 中缺少 `process.exit(0)` | 重新构建容器镜像 |

## 工作原理

```
容器 VM (192.168.64.x)
    │
    ├── eth0 → 网关 192.168.64.1
    │
bridge100 (192.168.64.1) ← 宿主机桥接，容器运行时由 vmnet 创建
    │
    ├── IP 转发 (sysctl) 将数据包从 bridge100 路由到 en0
    │
    ├── NAT (pfctl) 将 192.168.64.0/24 伪装为 en0 的 IP
    │
en0 (你的 WiFi/以太网) → 互联网
```

## 参考资料

- [apple/container#469](https://github.com/apple/container/issues/469) — macOS 26 上容器无网络
- [apple/container#656](https://github.com/apple/container/issues/656) — 构建过程中无法访问互联网 URL
