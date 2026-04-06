export type MemoryTier = 'core' | 'working' | 'peripheral';

export interface MemoryMetadata {
  l0_abstract?: string;
  l1_overview?: string;
  l2_content?: string;
  category?: string;
  memory_category?: string;
  source_session?: string;
  source?: string;
  state?: string;
  memory_layer?: string;
  injected_count?: number;
  last_injected_at?: number;
  last_confirmed_use_at?: number;
  bad_recall_count?: number;
  suppressed_until_turn?: number;
  accessCount?: number;
  access_count?: number;
  lastAccessedAt?: number;
  last_accessed_at?: number;
  createdAt?: number;
  created_at?: number;
  tier?: MemoryTier;
  confidence?: number;
  memory_temporal_type?: 'static' | 'dynamic';
}

export interface DecayableMemory {
  id: string;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  temporalType?: 'static' | 'dynamic';
}

export interface DecayScore {
  memoryId: string;
  recency: number;
  frequency: number;
  intrinsic: number;
  composite: number;
}

export interface RetrievalResult {
  entry: any; // We'll type this properly later with LanceDB row
  score: number;
  sources?: any;
}

export interface SmartMetadata {
  state?: string;
  memory_layer?: string;
  suppressed_until_turn?: number;
  memory_category?: string;
  tier?: MemoryTier;
  l0_abstract?: string;
  injected_count?: number;
  last_injected_at?: number;
  last_confirmed_use_at?: number;
  bad_recall_count?: number;
  access_count?: number;
  last_accessed_at?: number;
  created_at?: number;
  confidence?: number;
  memory_temporal_type?: 'static' | 'dynamic';
}
