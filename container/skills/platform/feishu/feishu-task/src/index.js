const https = require('https');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: __dirname + '/../.env' });

// Persistent token file location (survives container restarts)
const TOKEN_FILE = '/workspace/group/.feishu_refresh_token';

class FeishuTask {
  constructor() {
    this.appId = process.env.FEISHU_APP_ID;
    this.appSecret = process.env.FEISHU_APP_SECRET;

    // Load refresh_token: persistent file first, then env fallback
    this.refreshToken = this._loadRefreshToken();

    this.appAccessToken = null;
    this.appTokenExpireTime = 0;
    this.userAccessToken = null;
    this.userTokenExpireTime = 0;
  }

  /**
   * Load refresh_token from persistent file or environment variable.
   */
  _loadRefreshToken() {
    // 1. Try persistent file (most up-to-date after refresh)
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const token = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
        if (token) return token;
      }
    } catch { /* ignore */ }

    // 2. Fall back to environment variable (from .env)
    return process.env.FEISHU_USER_REFRESH_TOKEN || null;
  }

  /**
   * Persist new refresh_token so it survives container restarts.
   */
  _persistRefreshToken(token) {
    this.refreshToken = token;
    try {
      fs.writeFileSync(TOKEN_FILE, token, 'utf-8');
    } catch (err) {
      console.error(`[feishu-task] Warning: Could not persist refresh_token: ${err.message}`);
    }
  }

  async request(method, urlPath, data = null, accessToken = null) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'open.feishu.cn',
        path: urlPath,
        method: method,
        headers: {
          'Content-Type': 'application/json; charset=utf-8'
        }
      };

      if (accessToken) {
        options.headers['Authorization'] = `Bearer ${accessToken}`;
      }

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.code === 0) {
              resolve(result);
            } else {
              reject(new Error(`API Error: ${result.msg} (code: ${result.code})`));
            }
          } catch (e) {
            reject(new Error(`Response parse error: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => {
        reject(new Error(`Request error: ${e.message}`));
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    });
  }

  /**
   * Get app_access_token (needed to refresh user tokens).
   */
  async getAppAccessToken() {
    const now = Date.now();
    if (this.appAccessToken && now < this.appTokenExpireTime) {
      return this.appAccessToken;
    }

    const result = await this.request('POST', '/open-apis/auth/v3/app_access_token/internal', {
      app_id: this.appId,
      app_secret: this.appSecret
    });

    this.appAccessToken = result.app_access_token;
    this.appTokenExpireTime = now + (result.expire * 1000 - 60000);
    return this.appAccessToken;
  }

  /**
   * Get user_access_token via refresh_token.
   * Automatically persists the new refresh_token.
   */
  async getUserAccessToken() {
    const now = Date.now();
    if (this.userAccessToken && now < this.userTokenExpireTime) {
      return this.userAccessToken;
    }

    if (!this.refreshToken) {
      throw new Error(
        'FEISHU_USER_REFRESH_TOKEN not set. Run setup-oauth.js to complete OAuth authorization first.'
      );
    }

    const appToken = await this.getAppAccessToken();

    const result = await this.request(
      'POST',
      '/open-apis/authen/v1/oidc/refresh_access_token',
      {
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      },
      appToken
    );

    const data = result.data;
    this.userAccessToken = data.access_token;
    this.userTokenExpireTime = now + (data.expires_in * 1000 - 60000);

    // Persist the new refresh_token (old one is invalidated after use)
    if (data.refresh_token) {
      this._persistRefreshToken(data.refresh_token);
    }

    return this.userAccessToken;
  }

  async createTask(params) {
    const accessToken = await this.getUserAccessToken();

    const taskData = {
      summary: params.summary,
      description: params.description || '',
      members: params.members || []
    };

    // 转换时间格式：将字符串时间转为毫秒时间戳
    if (params.due && params.due.timestamp) {
      const timestampStr = params.due.timestamp;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestampStr)) {
        const date = new Date(timestampStr.replace(' ', 'T') + '+08:00');
        taskData.due = {
          timestamp: String(date.getTime()),
          is_all_day: params.due.is_all_day || false
        };
      } else {
        taskData.due = params.due;
      }
    }

    // user_access_token 模式下，API 自动识别调用者身份，不需要手动添加 follower
    const result = await this.request('POST', '/open-apis/task/v2/tasks', taskData, accessToken);
    return result;
  }

  async listTasks(params = {}) {
    const accessToken = await this.getUserAccessToken();
    const query = querystring.stringify({
      completed: params.completed !== undefined ? params.completed : false,
      page_size: params.page_size || 20
    });

    const result = await this.request('GET', `/open-apis/task/v2/tasks?${query}`, null, accessToken);
    return result;
  }

  async getTask(taskGuid) {
    const accessToken = await this.getUserAccessToken();
    const result = await this.request('GET', `/open-apis/task/v2/tasks/${taskGuid}`, null, accessToken);
    return result;
  }

  async updateTask(taskGuid, params) {
    const accessToken = await this.getUserAccessToken();
    const result = await this.request('PATCH', `/open-apis/task/v2/tasks/${taskGuid}`, params, accessToken);
    return result;
  }

  async completeTask(taskGuid, completedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    return this.updateTask(taskGuid, {
      completed_at: completedAt
    });
  }

  async uncompleteTask(taskGuid) {
    return this.updateTask(taskGuid, {
      completed_at: '0'
    });
  }

  async addMembers(taskGuid, members) {
    const accessToken = await this.getUserAccessToken();
    const result = await this.request('POST', `/open-apis/task/v2/tasks/${taskGuid}/members`, {
      members: members
    }, accessToken);
    return result;
  }

  async removeMembers(taskGuid, members) {
    const accessToken = await this.getUserAccessToken();
    const result = await this.request('POST', `/open-apis/task/v2/tasks/${taskGuid}/remove_members`, {
      members: members
    }, accessToken);
    return result;
  }

  async addSubtask(taskGuid, params) {
    const accessToken = await this.getUserAccessToken();

    const data = {
      summary: params.summary,
      description: params.description || '',
    };

    // 转换截止时间
    if (params.due && params.due.timestamp) {
      const timestampStr = params.due.timestamp;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestampStr)) {
        const date = new Date(timestampStr.replace(' ', 'T') + '+08:00');
        data.due = {
          timestamp: String(date.getTime()),
          is_all_day: params.due.is_all_day || false
        };
      } else {
        data.due = params.due;
      }
    }

    // 转换开始时间
    if (params.start && params.start.timestamp) {
      const timestampStr = params.start.timestamp;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestampStr)) {
        const date = new Date(timestampStr.replace(' ', 'T') + '+08:00');
        data.start = {
          timestamp: String(date.getTime()),
          is_all_day: params.start.is_all_day || false
        };
      } else {
        data.start = params.start;
      }
    }

    if (params.members && params.members.length > 0) {
      data.members = params.members.map(m => ({
        id: m.id,
        type: 'user',
        role: m.role || 'assignee'
      }));
    }

    const query = 'user_id_type=open_id';
    const result = await this.request('POST', `/open-apis/task/v2/tasks/${taskGuid}/subtasks?${query}`, data, accessToken);
    return result;
  }

  async listSubtasks(taskGuid, params = {}) {
    const accessToken = await this.getUserAccessToken();
    const query = querystring.stringify({
      page_size: params.page_size || 50,
      ...(params.page_token ? { page_token: params.page_token } : {}),
      user_id_type: 'open_id'
    });

    const result = await this.request('GET', `/open-apis/task/v2/tasks/${taskGuid}/subtasks?${query}`, null, accessToken);
    return result;
  }

  async deleteTask(taskGuid) {
    const accessToken = await this.getUserAccessToken();
    const result = await this.request('DELETE', `/open-apis/task/v2/tasks/${taskGuid}`, null, accessToken);
    return result;
  }
}

async function runCli() {
  const args = process.argv.slice(2);
  const action = args[0];
  const params = {};

  // 解析命令行参数
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i].replace('--', '');
    const value = args[i + 1];

    // 处理嵌套参数，例如 --due.timestamp
    if (key.includes('.')) {
      const [parent, child] = key.split('.');
      if (!params[parent]) params[parent] = {};
      params[parent][child] = value;
    } else if (value === 'true') {
      params[key] = true;
    } else if (value === 'false') {
      params[key] = false;
    } else if (!isNaN(value)) {
      params[key] = Number(value);
    } else if (value.startsWith('[') || value.startsWith('{')) {
      try {
        params[key] = JSON.parse(value);
      } catch (e) {
        params[key] = value;
      }
    } else {
      params[key] = value;
    }
  }

  params.action = action;
  const client = new FeishuTask();

  try {
    let result;
    switch (action) {
      case 'create':
        result = await client.createTask(params);
        break;
      case 'list':
        result = await client.listTasks(params);
        break;
      case 'get':
        if (!params.task_guid) {
          throw new Error('task_guid is required for get action');
        }
        result = await client.getTask(params.task_guid);
        break;
      case 'patch':
        if (!params.task_guid) {
          throw new Error('task_guid is required for patch action');
        }
        result = await client.updateTask(params.task_guid, params);
        break;
      case 'complete':
        if (!params.task_guid) {
          throw new Error('task_guid is required for complete action');
        }
        result = await client.completeTask(params.task_guid, params.completed_at);
        break;
      case 'uncomplete':
        if (!params.task_guid) {
          throw new Error('task_guid is required for uncomplete action');
        }
        result = await client.uncompleteTask(params.task_guid);
        break;
      case 'add_members':
        if (!params.task_guid) {
          throw new Error('task_guid is required for add_members action');
        }
        if (!params.members || !Array.isArray(params.members)) {
          throw new Error('members array is required for add_members action');
        }
        result = await client.addMembers(params.task_guid, params.members);
        break;
      case 'delete':
        if (!params.task_guid) {
          throw new Error('task_guid is required for delete action');
        }
        result = await client.deleteTask(params.task_guid);
        break;
      case 'remove_members':
        if (!params.task_guid) {
          throw new Error('task_guid is required for remove_members action');
        }
        if (!params.members || !Array.isArray(params.members)) {
          throw new Error('members array is required for remove_members action');
        }
        result = await client.removeMembers(params.task_guid, params.members);
        break;
      case 'add_subtask':
        if (!params.task_guid) {
          throw new Error('task_guid is required for add_subtask action');
        }
        if (!params.summary) {
          throw new Error('summary is required for add_subtask action');
        }
        result = await client.addSubtask(params.task_guid, params);
        break;
      case 'list_subtasks':
        if (!params.task_guid) {
          throw new Error('task_guid is required for list_subtasks action');
        }
        result = await client.listSubtasks(params.task_guid, params);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    // 输出结果
    console.log(JSON.stringify(result, null, 2));

    // 如果是创建任务，生成任务链接并保存
    if (action === 'create' && result.data && result.data.task) {
      const taskGuid = result.data.task.guid;
      const taskUrl = `https://applink.feishu.cn/client/task/detail/${taskGuid}`;
      console.log(`\n✅ 任务创建成功！任务链接：${taskUrl}`);

      // 保存到最近创建的任务文件
      const recentTasksPath = path.join(__dirname, '../recent_tasks.json');
      let recentTasks = [];
      if (fs.existsSync(recentTasksPath)) {
        recentTasks = JSON.parse(fs.readFileSync(recentTasksPath, 'utf8'));
      }
      recentTasks.unshift({
        task_guid: taskGuid,
        summary: params.summary,
        created_at: new Date().toISOString(),
        url: taskUrl
      });
      if (recentTasks.length > 20) recentTasks = recentTasks.slice(0, 20);
      fs.writeFileSync(recentTasksPath, JSON.stringify(recentTasks, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({
      success: false,
      error: error.message
    }, null, 2));
    process.exit(1);
  }
}

// 如果是直接运行脚本（不是作为模块导入）
if (require.main === module) {
  runCli();
} else {
  // 作为模块导出
  module.exports = async function feishuTaskSkill(params) {
    const client = new FeishuTask();

    try {
      switch (params.action) {
        case 'create':
          return await client.createTask(params);
        case 'list':
          return await client.listTasks(params);
        case 'get':
          if (!params.task_guid) {
            throw new Error('task_guid is required for get action');
          }
          return await client.getTask(params.task_guid);
        case 'patch':
          if (!params.task_guid) {
            throw new Error('task_guid is required for patch action');
          }
          return await client.updateTask(params.task_guid, params);
        case 'complete':
          if (!params.task_guid) {
            throw new Error('task_guid is required for complete action');
          }
          return await client.completeTask(params.task_guid, params.completed_at);
        case 'uncomplete':
          if (!params.task_guid) {
            throw new Error('task_guid is required for uncomplete action');
          }
          return await client.uncompleteTask(params.task_guid);
        case 'add_members':
          if (!params.task_guid) {
            throw new Error('task_guid is required for add_members action');
          }
          if (!params.members || !Array.isArray(params.members)) {
            throw new Error('members array is required for add_members action');
          }
          return await client.addMembers(params.task_guid, params.members);
        case 'delete':
          if (!params.task_guid) {
            throw new Error('task_guid is required for delete action');
          }
          return await client.deleteTask(params.task_guid);
        case 'remove_members':
          if (!params.task_guid) {
            throw new Error('task_guid is required for remove_members action');
          }
          if (!params.members || !Array.isArray(params.members)) {
            throw new Error('members array is required for remove_members action');
          }
          return await client.removeMembers(params.task_guid, params.members);
        case 'add_subtask':
          if (!params.task_guid) {
            throw new Error('task_guid is required for add_subtask action');
          }
          if (!params.summary) {
            throw new Error('summary is required for add_subtask action');
          }
          return await client.addSubtask(params.task_guid, params);
        case 'list_subtasks':
          if (!params.task_guid) {
            throw new Error('task_guid is required for list_subtasks action');
          }
          return await client.listSubtasks(params.task_guid, params);
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  };
}
