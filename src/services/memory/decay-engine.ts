import { DecayableMemory, DecayScore, MemoryTier, RetrievalResult } from './types.js';

const MS_PER_DAY = 86_400_000;

export interface DecayConfig {
  recencyHalfLifeDays: number;
  recencyWeight: number;
  frequencyWeight: number;
  intrinsicWeight: number;
  staleThreshold: number;
  searchBoostMin: number;
  importanceModulation: number;
  betaCore: number;
  betaWorking: number;
  betaPeripheral: number;
  coreDecayFloor: number;
  workingDecayFloor: number;
  peripheralDecayFloor: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  recencyHalfLifeDays: 30,
  recencyWeight: 0.4,
  frequencyWeight: 0.3,
  intrinsicWeight: 0.3,
  staleThreshold: 0.3,
  searchBoostMin: 0.3,
  importanceModulation: 1.5,
  betaCore: 0.8,
  betaWorking: 1.0,
  betaPeripheral: 1.3,
  coreDecayFloor: 0.9,
  workingDecayFloor: 0.7,
  peripheralDecayFloor: 0.5,
};

export class DecayEngine {
  constructor(private config: DecayConfig = DEFAULT_DECAY_CONFIG) {}

  private getTierBeta(tier: MemoryTier): number {
    switch (tier) {
      case 'core': return this.config.betaCore;
      case 'working': return this.config.betaWorking;
      case 'peripheral': return this.config.betaPeripheral;
    }
  }

  private getTierFloor(tier: MemoryTier): number {
    switch (tier) {
      case 'core': return this.config.coreDecayFloor;
      case 'working': return this.config.workingDecayFloor;
      case 'peripheral': return this.config.peripheralDecayFloor;
    }
  }

  private recency(memory: DecayableMemory, now: number): number {
    const lastActive = memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
    const baseHL = memory.temporalType === 'dynamic' ? this.config.recencyHalfLifeDays / 3 : this.config.recencyHalfLifeDays;
    const effectiveHL = baseHL * Math.exp(this.config.importanceModulation * memory.importance);
    const lambda = Math.LN2 / effectiveHL;
    const beta = this.getTierBeta(memory.tier);
    return Math.exp(-lambda * Math.pow(daysSince, beta));
  }

  private frequency(memory: DecayableMemory): number {
    const base = 1 - Math.exp(-memory.accessCount / 5);
    if (memory.accessCount <= 1) return base;

    const lastActive = memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const accessSpanDays = Math.max(1, (lastActive - memory.createdAt) / MS_PER_DAY);
    const avgGapDays = accessSpanDays / Math.max(memory.accessCount - 1, 1);
    const recentnessBonus = Math.exp(-avgGapDays / 30);
    return base * (0.5 + 0.5 * recentnessBonus);
  }

  private intrinsic(memory: DecayableMemory): number {
    return memory.importance * memory.confidence;
  }

  public score(memory: DecayableMemory, now: number = Date.now()): DecayScore {
    const r = this.recency(memory, now);
    const f = this.frequency(memory);
    const i = this.intrinsic(memory);
    const composite = this.config.recencyWeight * r + this.config.frequencyWeight * f + this.config.intrinsicWeight * i;

    return {
      memoryId: memory.id,
      recency: r,
      frequency: f,
      intrinsic: i,
      composite,
    };
  }

  public applySearchBoost(results: { memory: DecayableMemory; score: number }[], now: number = Date.now()): void {
    for (const r of results) {
      const ds = this.score(r.memory, now);
      const tierFloor = Math.max(this.getTierFloor(r.memory.tier), ds.composite);
      const multiplier = this.config.searchBoostMin + ((1 - this.config.searchBoostMin) * tierFloor);
      r.score *= Math.min(1, Math.max(this.config.searchBoostMin, multiplier));
    }
  }
}
