# AI 全自动泛域名发布流水线方案 (AI Wildcard Deployment Pipeline)

本方案旨在建立一套**零 API 授权、全本地路由、极速秒开**的自动化 Web 发布架构。
使得运行在沙盒（如 NanoClaw）中的 AI Agent 能够在没有任何 Cloudflare 公网控制台密码的情况下，安全、自动地为你分配任意子域名（如 `web1.alaya.moe`、`game.alaya.moe`）并推送代码上线。

---

## 核心架构概览

*   **Cloudflare (公网屏障)**: 仅需一次性将 `*.alaya.moe` 泛解析 A 记录指向你的宿主机真实公网 IP，并开启黄云代理（Proxied）。此后，任何外网子域名的流量全会通过 CDN 过滤后砸向你的宿主机。
*   **Caddy (主网关门卫)**: 极其轻量的宿主机 `docker-compose` 容器，绑定监听 `80` 和 `443`。它动态监测配置文件的变化，负责把对应请求（如找 `web1` 的）引流向指定的目录。
*   **NanoClaw AI 容器**: 原本封闭的 AI 沙盒。通过挂载两对相同的**数据卷 (Volumes)**（代码仓和路由配设），获得与 Caddy 通信的“秘密通道”。

---

## 实施指南

### 阶段一：宿主机建站与主网关配置 (人工一次性操作)

1. **建立共享基建目录**
   在宿主机的合适位置建立代码与门卫规则的数据中心：
   ```bash
   mkdir -p ~/CodeSpace/production_apps/deployments   # 存放各类生产级代码
   mkdir -p ~/CodeSpace/production_apps/caddy_conf     # 存放被动态注入的子域名 Caddy 规则
   ```

2. **部署长期存活的 Caddy 网关容器**
   在上述同级目录下创建 `docker-compose.yml`：
   ```yaml
   version: '3.8'
   services:
     alaya_gateway:
       image: caddy:latest
       container_name: alaya_caddy
       restart: always
       network_mode: "host" # 与宿主机共享网络直接接管流入 80/443 的流量
       volumes:
         # 加载主控配置
         - ./Caddyfile:/etc/caddy/Caddyfile
         # 后续 AI 会向这里空投子域名配置
         - ./caddy_conf:/etc/caddy/caddy_conf
         # 指向真正的生产网页代码聚集地
         - ./deployments:/app/deployments
   ```

3. **创建极简主路由表 `Caddyfile`**
   ```text
   # Caddyfile 完全不需要写逻辑，只用包容地引入即可
   import /etc/caddy/caddy_conf/*.caddy
   ```
   随后执行 `docker-compose up -d` 启动网关。基础设施自此完毕。

---

### 阶段二：打通与 AI 沙盒的底层地道

请核查或修改你启动 NanoClaw （AI 服务器）的挂载命令，强制把刚才建立的这两个宿主文件夹共享进 AI 容器内部。
例如在 `docker run` 或所属的 `docker-compose` `volumes` 中追加：
```yaml
      - ~/CodeSpace/production_apps/deployments:/workspace/production_deployments
      - ~/CodeSpace/production_apps/caddy_conf:/workspace/caddy_conf
```

---

### 阶段三：建立专属发布动作 (赋予 AI 的 SKILL)

你需要去 NanoClaw 的技能目录中（如 `/.claude/skills/deploy-to-production/SKILL.md`）添加一份供 AI 阅读的任务规范：

> **技能名称：全自动化永久部署 (auto-deploy-production)**
> **描述：** 用户下发部署指令后，通过 Caddy 反向代理网关实现秒级全智能域名绑定与代码推送。
>
> 你的操作流水线如下：
> 1. **拷入代码：** 建立对应的正式区文件夹，并将清理好的生产态代码硬拷贝过去。
>    `mkdir -p /workspace/production_deployments/<工程名>`
>    `cp -r ./* /workspace/production_deployments/<工程名>/`
>
> 2. **生成网关规章：** 新建并直接覆盖写入该子域名专属的 `.caddy` 规则档案。如果你被要求分配到 `web1.alaya.moe`：
>    ```bash
>    cat << 'EOF' > /workspace/caddy_conf/<工程名>.caddy
>    web1.alaya.moe {
>        root * /app/deployments/<工程名>
>        file_server
>    }
>    EOF
>    ```
>    *注意此处必须用 `/app/...` 路径，这是遵循对面 Caddy 容器的视角映射。*
>
> 3. **热重载门卫：** 强制令 Caddy 生效，不会因为重启断连现有的任何连接。
>    `curl -X POST "http://localhost:2019/load" -H "Content-Type: application/json" -d @<(curl -s http://localhost:2019/config/)`
>    如果 AI 没有网络权限触及该接口，则可由系统执行或要求用户运行短平快的容器重启：`docker restart alaya_caddy`。

至此，只要你的一句：“推代码上线，域名用 XXX”。上述管道便会在 `1000` 毫秒内顺畅流转完毕，外网直接即可访问刚刚落地的全新页面！
