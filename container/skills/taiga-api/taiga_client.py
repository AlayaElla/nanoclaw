#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Taiga API 客户端库
用于与 Taiga 项目管理工具交互喵～
"""

import requests
import json
import os
from pathlib import Path
from typing import Optional, Tuple, Dict, Any, List
from dotenv import load_dotenv


def load_env():
    """从 .env 文件加载环境变量喵～"""
    # 查找 .env 文件（在当前脚本目录或当前工作目录）
    script_dir = Path(__file__).parent
    env_file = script_dir / '.env'

    if env_file.exists():
        load_dotenv(env_file)
        return True
    return False


class TaigaClient:
    """Taiga API 客户端"""

    def __init__(self, base_url: str, username: str = None, password: str = None):
        """
        初始化 Taiga 客户端

        Args:
            base_url: Taiga 实例的基础 URL
            username: 用户名（可选，如果已持有 token）
            password: 密码（可选，如果已持有 token）
        """
        self.base_url = base_url.rstrip('/')
        self.auth_token: Optional[str] = None
        self.refresh_token: Optional[str] = None
        self.username = username
        self._password = password

    def login(self, username: str = None, password: str = None) -> Tuple[str, str]:
        """
        登录并获取认证 token

        Args:
            username: 用户名
            password: 密码

        Returns:
            (auth_token, refresh_token) 元组
        """
        username = username or self.username
        password = password or self._password

        if not username or not password:
            raise ValueError("需要提供用户名和密码喵～")

        response = requests.post(
            f"{self.base_url}/api/v1/auth",
            json={
                "type": "normal",
                "username": username,
                "password": password
            }
        )

        if response.status_code != 200:
            raise Exception(f"登录失败：{response.status_code} - {response.text}")

        data = response.json()
        self.auth_token = data.get("auth_token")
        self.refresh_token = data.get("refresh_token")

        return self.auth_token, self.refresh_token

    def _get_headers(self) -> Dict[str, str]:
        """获取请求头"""
        headers = {
            "Content-Type": "application/json"
        }
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"
        return headers

    def _request(self, method: str, endpoint: str, data: Dict = None) -> Tuple[int, Any]:
        """
        发送 API 请求

        Args:
            method: HTTP 方法 (GET, POST, PUT, DELETE)
            endpoint: API 端点（不包含 /api/v1/ 前缀）
            data: 请求数据（用于 POST/PUT）

        Returns:
            (status_code, response_data) 元组
        """
        url = f"{self.base_url}/api/v1/{endpoint}"
        headers = self._get_headers()

        response = requests.request(method, url, headers=headers, json=data)

        try:
            return response.status_code, response.json()
        except json.JSONDecodeError:
            return response.status_code, {"text": response.text}

    def get(self, endpoint: str, params: Dict = None) -> Tuple[int, Any]:
        """发送 GET 请求"""
        if params:
            query = "&".join(f"{k}={v}" for k, v in params.items())
            endpoint = f"{endpoint}?{query}"
        return self._request("GET", endpoint)

    def post(self, endpoint: str, data: Dict) -> Tuple[int, Any]:
        """发送 POST 请求"""
        return self._request("POST", endpoint, data)

    def put(self, endpoint: str, data: Dict) -> Tuple[int, Any]:
        """发送 PUT 请求"""
        return self._request("PUT", endpoint, data)

    def delete(self, endpoint: str) -> Tuple[int, Any]:
        """发送 DELETE 请求"""
        return self._request("DELETE", endpoint)

    def refresh_auth(self) -> Tuple[str, str]:
        """
        刷新认证 token

        Returns:
            (new_auth_token, new_refresh_token) 元组
        """
        if not self.refresh_token:
            raise ValueError("没有 refresh_token，请重新登录喵～")

        response = requests.post(
            f"{self.base_url}/api/v1/auth/refresh",
            json={"refresh_token": self.refresh_token}
        )

        if response.status_code != 200:
            raise Exception(f"刷新 token 失败：{response.status_code}")

        data = response.json()
        self.auth_token = data.get("auth_token")
        self.refresh_token = data.get("refresh_token")

        return self.auth_token, self.refresh_token

    # ========== 用户相关 ==========

    def get_current_user(self) -> Tuple[int, Any]:
        """获取当前用户信息"""
        return self.get("users/me")

    # ========== 项目相关 ==========

    def get_projects(self) -> Tuple[int, List]:
        """获取所有项目"""
        return self.get("projects/")

    def get_project(self, project_id: int) -> Tuple[int, Any]:
        """获取指定项目详情"""
        return self.get(f"projects/{project_id}")

    def create_project(self, name: str, description: str = "") -> Tuple[int, Any]:
        """创建新项目"""
        return self.post("projects/", {
            "name": name,
            "description": description
        })

    # ========== 用户故事相关 ==========

    def get_user_stories(self, project_id: int = None) -> Tuple[int, List]:
        """获取用户故事列表"""
        params = {}
        if project_id:
            params["project"] = project_id
        return self.get("userstories/", params)

    def get_user_story(self, story_id: int) -> Tuple[int, Any]:
        """获取指定用户故事详情"""
        return self.get(f"userstories/{story_id}")

    def create_user_story(self, project_id: int, subject: str,
                          description: str = "", **kwargs) -> Tuple[int, Any]:
        """创建用户故事"""
        data = {
            "project": project_id,
            "subject": subject,
            "description": description,
            **kwargs
        }
        return self.post("userstories/", data)

    def update_user_story(self, story_id: int, **kwargs) -> Tuple[int, Any]:
        """更新用户故事"""
        return self.put(f"userstories/{story_id}", kwargs)

    def delete_user_story(self, story_id: int) -> Tuple[int, Any]:
        """删除用户故事"""
        return self.delete(f"userstories/{story_id}")

    # ========== 任务相关 ==========

    def get_tasks(self, project_id: int = None, user_story_id: int = None) -> Tuple[int, List]:
        """获取任务列表"""
        params = {}
        if project_id:
            params["project"] = project_id
        if user_story_id:
            params["user_story"] = user_story_id
        return self.get("tasks/", params)

    def get_task(self, task_id: int) -> Tuple[int, Any]:
        """获取指定任务详情"""
        return self.get(f"tasks/{task_id}")

    def create_task(self, project_id: int, subject: str,
                    user_story_id: int = None, **kwargs) -> Tuple[int, Any]:
        """创建任务"""
        data = {
            "project": project_id,
            "subject": subject,
            **kwargs
        }
        if user_story_id:
            data["user_story"] = user_story_id
        return self.post("tasks/", data)

    def update_task(self, task_id: int, **kwargs) -> Tuple[int, Any]:
        """更新任务"""
        return self.put(f"tasks/{task_id}", kwargs)

    def delete_task(self, task_id: int) -> Tuple[int, Any]:
        """删除任务"""
        return self.delete(f"tasks/{task_id}")

    # ========== 问题/Issue 相关 ==========

    def get_issues(self, project_id: int = None) -> Tuple[int, List]:
        """获取问题列表"""
        params = {}
        if project_id:
            params["project"] = project_id
        return self.get("issues/", params)

    def create_issue(self, project_id: int, subject: str,
                     issue_type: str = "bug", **kwargs) -> Tuple[int, Any]:
        """创建问题"""
        data = {
            "project": project_id,
            "subject": subject,
            "type": issue_type,
            **kwargs
        }
        return self.post("issues/", data)

    # ========== 里程碑/冲刺相关 ==========

    def get_milestones(self, project_id: int) -> Tuple[int, List]:
        """获取里程碑列表"""
        return self.get(f"milestones/?project={project_id}")

    def get_sprints(self, project_id: int) -> Tuple[int, List]:
        """获取冲刺列表"""
        return self.get(f"sprints/?project={project_id}")

    # ========== 保存和加载凭证 ==========

    def save_credentials(self, filepath: str = "taiga_credentials.json"):
        """保存凭证到文件"""
        credentials = {
            "base_url": self.base_url,
            "username": self.username,
            "auth_token": self.auth_token,
            "refresh_token": self.refresh_token
        }
        with open(filepath, 'w') as f:
            json.dump(credentials, f, indent=2)
        print(f"凭证已保存到 {filepath} 喵～")

    def load_credentials(self, filepath: str = "taiga_credentials.json") -> bool:
        """从文件加载凭证"""
        try:
            with open(filepath, 'r') as f:
                credentials = json.load(f)
            self.base_url = credentials.get("base_url", self.base_url)
            self.username = credentials.get("username", self.username)
            self.auth_token = credentials.get("auth_token")
            self.refresh_token = credentials.get("refresh_token")
            print(f"凭证已从 {filepath} 加载喵～")
            return True
        except FileNotFoundError:
            print(f"凭证文件 {filepath} 不存在喵～")
            return False


# ========== 便捷函数 ==========

def create_client(base_url: str = None, username: str = None, password: str = None) -> TaigaClient:
    """
    创建并登录客户端

    优先级：
    1. 直接传入的参数
    2. 环境变量（TAIGA_BASE_URL, TAIGA_USERNAME, TAIGA_PASSWORD）
    3. .env 文件中的配置
    """
    # 尝试从 .env 文件加载
    load_env()

    # 从环境变量获取（如果没有直接传入参数）
    base_url = base_url or os.environ.get('TAIGA_BASE_URL')
    username = username or os.environ.get('TAIGA_USERNAME')
    password = password or os.environ.get('TAIGA_PASSWORD')

    if not base_url:
        raise ValueError("需要指定 TAIGA_BASE_URL 喵～")

    client = TaigaClient(base_url, username, password)

    # 如果有用户名密码就登录，否则假设已有 token
    if username and password:
        client.login()
    elif client.auth_token:
        print("已使用现有 token 喵～")

    return client


# ========== 使用示例 ==========

if __name__ == "__main__":
    # 方式 1：从 .env 文件自动加载配置（推荐）
    print("=== 从 .env 加载配置 ===")
    client = create_client()

    # 获取当前用户信息
    status, user = client.get_current_user()
    print(f"当前用户：{user.get('username')}")

    # 获取所有项目
    status, projects = client.get_projects()
    print(f"项目数量：{len(projects)}")

    # 方式 2：直接传入参数
    # client = create_client(
    #     base_url="https://taiga.example.com",
    #     username="your_username",
    #     password="your_password"
    # )

    # 方式 3：使用环境变量
    # export TAIGA_BASE_URL=...
    # export TAIGA_USERNAME=...
    # export TAIGA_PASSWORD=...
    # client = create_client()
