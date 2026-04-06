import { logger } from '../logger.js';

export type FailureScenario = 'TimeoutNoOutput' | 'ContainerCrash' | 'Unknown';

export interface RecoveryAction {
  type: 'retry_with_prompt';
  systemPrompt: string;
}

export interface RecoveryRecipe {
  scenario: FailureScenario;
  maxAttempts: number;
  delayMs: number;
  action: RecoveryAction;
}

const RECIPES: Record<FailureScenario, RecoveryRecipe> = {
  TimeoutNoOutput: {
    scenario: 'TimeoutNoOutput',
    maxAttempts: 1,
    delayMs: 3000,
    action: {
      type: 'retry_with_prompt',
      systemPrompt:
        '[System Recovery] 上次执行或服务请求因网络或运行超时被系统终止。我们已为您强行重启并重置了运行沙箱。请不要使用极易导致资源堵塞的循环或长时间执行的脚本，请换一种安全思路推进刚才受阻的动作。',
    },
  },
  ContainerCrash: {
    scenario: 'ContainerCrash',
    maxAttempts: 1,
    delayMs: 2000,
    action: {
      type: 'retry_with_prompt',
      systemPrompt:
        '[System Recovery] 刚才的容器进程因为底层致命错误(Exit Code异常)而意外崩溃。环境已经为您强制刷新，请绝对不要再执行刚刚引起崩溃的同构工具参数或命令，更换策略以免再次宕机。',
    },
  },
  Unknown: {
    scenario: 'Unknown',
    maxAttempts: 0,
    delayMs: 0,
    action: {
      type: 'retry_with_prompt',
      systemPrompt: '',
    },
  },
};

// tracks attempts per group folder
const recoveryAttempts: Record<string, Record<FailureScenario, number>> = {};

/**
 * Parses generic error strings or objects from the container runner
 * and categorizes them into actionable failure scenarios.
 */
export function classifyError(errorData: any): FailureScenario {
  const errStr =
    typeof errorData === 'string' ? errorData : JSON.stringify(errorData || {});
  if (errStr.includes('timed out after') || errStr.includes('TIMEOUT')) {
    return 'TimeoutNoOutput';
  }
  // Currently NanoClaw resolves { status: 'error', error: '...' } when exitCode !== 0
  // or it might pass other strings. We loosely match crash patterns.
  if (
    errStr.includes('Container crash') ||
    errStr.includes('exit code') ||
    errStr.includes('Container agent error')
  ) {
    return 'ContainerCrash';
  }
  return 'Unknown';
}

/**
 * Evaluates whether a recovery attempt is permitted for this group and scenario.
 * If permitted, returns the valid RecoveryRecipe and increments the strike counter.
 */
export function getRecoveryAction(
  groupFolder: string,
  scenario: FailureScenario,
): RecoveryRecipe | null {
  const recipe = RECIPES[scenario];
  if (!recipe || recipe.maxAttempts === 0) return null;

  if (!recoveryAttempts[groupFolder]) {
    recoveryAttempts[groupFolder] = {
      TimeoutNoOutput: 0,
      ContainerCrash: 0,
      Unknown: 0,
    };
  }

  if (recoveryAttempts[groupFolder][scenario] < recipe.maxAttempts) {
    recoveryAttempts[groupFolder][scenario]++;
    logger.warn(
      {
        groupFolder,
        scenario,
        attempt: recoveryAttempts[groupFolder][scenario],
      },
      'Triggering automated recovery action',
    );
    return recipe;
  }

  logger.error(
    { groupFolder, scenario },
    'Max auto-recovery attempts reached. Escalating to human.',
  );
  return null;
}

/**
 * Call this when an agent completes a successful loop to clear its strikes.
 */
export function clearRecoveryState(groupFolder: string): void {
  if (recoveryAttempts[groupFolder]) {
    delete recoveryAttempts[groupFolder];
    logger.debug({ groupFolder }, 'Cleared recovery strike counters');
  }
}
