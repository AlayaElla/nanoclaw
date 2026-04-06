import { DecayableMemory, DecayScore, MemoryTier } from './types.js';

export interface TierTransition {
  fromTier: MemoryTier;
  toTier: MemoryTier;
  reason: string;
}

export class TierManager {
  // Thresholds for promotion
  private workingThreshold = 0.65;
  private coreThreshold = 0.85;

  // Thresholds for demotion (lower than promotion to create hysteresis)
  private peripheralDemoteThreshold = 0.45;
  private workingDemoteThreshold = 0.7;

  public evaluate(
    memory: DecayableMemory,
    currentScore: DecayScore,
    now: number = Date.now(),
  ): TierTransition | null {
    const { composite } = currentScore;

    // Promote Peripheral -> Working
    if (memory.tier === 'peripheral' && composite >= this.workingThreshold) {
      if (memory.accessCount >= 2) {
        return {
          fromTier: 'peripheral',
          toTier: 'working',
          reason: 'Score improved and accessed multiple times',
        };
      }
    }

    // Promote Working -> Core
    if (memory.tier === 'working' && composite >= this.coreThreshold) {
      if (memory.accessCount >= 5) {
        return {
          fromTier: 'working',
          toTier: 'core',
          reason: 'High score and robust access history',
        };
      }
    }

    // Demote Core -> Working
    if (memory.tier === 'core' && composite < this.workingDemoteThreshold) {
      const daysSinceAccess = (now - memory.lastAccessedAt) / 86400000;
      if (daysSinceAccess > 30) {
        return {
          fromTier: 'core',
          toTier: 'working',
          reason: 'Score degraded and not accessed recently',
        };
      }
    }

    // Demote Working -> Peripheral
    if (
      memory.tier === 'working' &&
      composite < this.peripheralDemoteThreshold
    ) {
      return {
        fromTier: 'working',
        toTier: 'peripheral',
        reason: 'Score dropped below working threshold',
      };
    }

    return null;
  }
}
