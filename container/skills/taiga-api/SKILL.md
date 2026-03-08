# Taiga API 技能

## 概述

这个技能让星梦能够通过 Taiga API 与 Taiga 项目管理工具交互喵～

## 认证信息

**Taiga 实例**: https://taiga.merveille-scope.store/

**认证方式**: Token 认证

**登录端点**: `POST /api/v1/auth`

## API 使用方法

### 1. 获取认证 Token

```python
import requests

BASE_URL = "https://taiga.merveille-scope.store"

def login(username, password):
    """登录并获取 auth_token"""
    response = requests.post(
        f"{BASE_URL}/api/v1/auth",
        json={
            "type": "normal",
            "username": username,
            "password": password
        }
    )
    data = response.json()
    return data.get("auth_token"), data.get("refresh_token")
```

### 2. 使用 Token 调用 API

```python
def api_request(endpoint, token, method="GET", data=None):
    """发送 API 请求"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }

    url = f"{BASE_URL}/api/v1/{endpoint}"

    if method == "GET":
        response = requests.get(url, headers=headers)
    elif method == "POST":
        response = requests.post(url, headers=headers, json=data)
    elif method == "PUT":
        response = requests.put(url, headers=headers, json=data)
    elif method == "DELETE":
        response = requests.delete(url, headers=headers)

    return response.status_code, response.json()
```

### 3. 刷新 Token

```python
def refresh_token(refresh_token):
    """刷新 auth_token"""
    response = requests.post(
        f"{BASE_URL}/api/v1/auth/refresh",
        json={"refresh_token": refresh_token}
    )
    data = response.json()
    return data.get("auth_token"), data.get("refresh_token")
```

## 常用 API 端点

| 端点 | 方法 | 描述 |
|------|------|------|
| `/api/v1/users/me` | GET | 获取当前用户信息 |
| `/api/v1/projects/` | GET | 获取所有项目 |
| `/api/v1/projects/{id}` | GET | 获取指定项目详情 |
| `/api/v1/userstories/` | GET | 获取用户故事列表 |
| `/api/v1/userstories/` | POST | 创建用户故事 |
| `/api/v1/tasks/` | GET | 获取任务列表 |
| `/api/v1/tasks/` | POST | 创建任务 |
| `/api/v1/issues/` | GET | 获取问题列表 |
| `/api/v1/milestones/` | GET | 获取里程碑列表 |
| `/api/v1/sprints/` | GET | 获取冲刺列表 |

## 使用示例

### 获取当前用户信息
```python
token, _ = login(username, password)
status, user_info = api_request("users/me", token)
```

### 获取所有项目
```python
status, projects = api_request("projects/", token)
```

### 获取项目的用户故事
```python
status, stories = api_request(f"userstories/?project={project_id}", token)
```

### 创建用户故事
```python
new_story = {
    "project": project_id,
    "subject": "新功能：用户登录",
    "description": "实现用户登录功能"
}
status, created = api_request("userstories/", token, method="POST", data=new_story)
```

## 注意事项

1. **Token 过期**: auth_token 会过期（默认 24 小时），需要使用 `refresh_auth()` 刷新
2. **密码安全**:
   - ⚠️ 不要在代码中硬编码密码
   - ✅ 使用 `.env` 文件（已添加到 `.gitignore`）
   - ✅ 或使用环境变量
   - ✅ 或使用 `save_credentials()` 保存到本地
3. **错误处理**: API 请求可能失败，需要处理 HTTP 错误状态码
4. **速率限制**: 注意 API 调用频率，避免触发限流
5. **.env 文件安全**: `.env` 文件已被 `.gitignore` 忽略，不要手动提交到 git

## 配置方式

### 方式 1：使用 .env 文件（推荐）

创建 `.env` 文件（已被 `.gitignore` 忽略，安全喵～）：

```bash
TAIGA_BASE_URL=https://taiga.merveille-scope.store
TAIGA_USERNAME=your_username
TAIGA_PASSWORD=your_password
```

然后直接使用：
```python
from taiga_client import create_client

# 自动从 .env 加载配置
client = create_client()
```

### 方式 2：使用环境变量

```bash
export TAIGA_BASE_URL=https://taiga.merveille-scope.store
export TAIGA_USERNAME=your_username
export TAIGA_PASSWORD=your_password
```

```python
from taiga_client import create_client
client = create_client()
```

### 方式 3：直接传入参数

```python
from taiga_client import create_client

client = create_client(
    base_url="https://taiga.merveille-scope.store",
    username="your_username",
    password="your_password"
)
```

### 方式 4：使用凭证文件

```python
from taiga_client import TaigaClient

client = TaigaClient(base_url, username, password)
client.login()

# 保存凭证到文件
client.save_credentials()  # 保存到 taiga_credentials.json

# 下次从文件加载
client.load_credentials()
client.login()  # 使用加载的凭证登录
```

## 安装时间

2026-03-07

## 文件位置

`/workspace/group/skills/taiga-api/`
