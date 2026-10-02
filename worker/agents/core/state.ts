import type { PhasicBlueprint, AgenticBlueprint, PhaseConceptType ,
    FileOutputType,
    Blueprint,
} from '../schemas';
import type { InferenceMetadata } from '../inferutils/config.types';
import { BehaviorType, Plan, ProjectType } from './types';

export interface FileState extends FileOutputType {
    lastDiff: string;
}

export interface FileServingToken {
    token: string;
    createdAt: number;
}

export interface PhaseState extends PhaseConceptType {
    // deploymentNeeded: boolean;
    completed: boolean;
}

export enum CurrentDevState {
    IDLE,
    PHASE_GENERATING,
    PHASE_IMPLEMENTING,
    REVIEWING,
    FINALIZING,
}

export const MAX_PHASES = 10;

/** Common state fields for all agent behaviors */
export interface BaseProjectState {
    behaviorType: BehaviorType;
    projectType: ProjectType;
    
    // Identity
    projectName: string;
    query: string;
    sessionId: string;
    hostname: string;

    blueprint: Blueprint;

    templateName: string | 'custom';
    
    // Inference context
    readonly metadata: InferenceMetadata;
    
    // Generation control
    shouldBeGenerating: boolean;
    
    // Common file storage
    generatedFilesMap: Record<string, FileState>;
    
    // Common infrastructure
    sandboxInstanceId?: string;
    fileServingToken?: FileServingToken;
    commandsHistory?: string[];
    lastPackageJson?: string;
    pendingUserInputs: string[];
    projectUpdatesAccumulator: string[];
    
    // Deep debug
    lastDeepDebugTranscript: string | null;

    mvpGenerated: boolean;
    reviewingInitiated: boolean;
    cloudflareToken?: string; // Encrypted Cloudflare OAuth token blob (backend decrypts when needed)
    wsOrigin?: string; // Origin captured at WS upgrade time for token refresh
}

/** Phasic agent state */
export interface PhasicState extends BaseProjectState {
    behaviorType: 'phasic';
    blueprint: PhasicBlueprint;
    generatedPhases: PhaseState[];
    
    phasesCounter: number;
    currentDevState: CurrentDevState;
    reviewCycles?: number;
    currentPhase?: PhaseConceptType;
}

export interface WorkflowMetadata {
    name: string;
    description: string;
    params: Record<string, {
        type: 'string' | 'number' | 'boolean' | 'object';
        description: string;
        example?: unknown;
        required: boolean;
    }>;
    bindings?: {
        envVars?: Record<string, {
            type: 'string';
            description: string;
            default?: string;
            required?: boolean;
        }>;
        secrets?: Record<string, {
            type: 'secret';
            description: string;
            required?: boolean;
        }>;
        resources?: Record<string, {
            type: 'kv' | 'r2' | 'd1' | 'queue' | 'ai';
            description: string;
            required?: boolean;
        }>;
    };
}

/** Agentic agent state */
export interface AgenticState extends BaseProjectState {
    behaviorType: 'agentic';
    blueprint: AgenticBlueprint;
    currentPlan: Plan;
}

/**
 * Think agent state — backed by `@cloudflare/think` (ThinkAgent DO) for the
 * agentic loop and `@space-do/space` SpaceDO for files/preview/deploy.
 *
 * Files are *not* mirrored into `generatedFilesMap`; they live in the
 * companion `SpaceDO` workspace and are read on demand via RPC. The map is
 * kept for shape compatibility and used as a small in-memory cache.
 */
export interface ThinkState extends BaseProjectState {
    behaviorType: 'think';
    blueprint: AgenticBlueprint;
    /** ThinkAgent DO `idFromName` key (the agent id). */
    thinkAgentName: string;
    /** Git branch used for deployment previews. */
    currentBranch: string;
    /** Last commit SHA we successfully deployed. */
    lastDeployedCommit?: string;
    cloudflareDeploymentUrl?: string;
    /** Nova Sites: History labels by commit (what was asked, or what the owner changed). */
    novaLabels?: Record<string, string>;
    /** Nova Sites: the commit that is live at the site's address. */
    novaPublishedHash?: string;
    /** Nova Sites: the site's address is switched off (Unpublish); nothing deleted. */
    novaUnpublished?: boolean;
    /** Nova Sites: what the owner did by hand since Nova's last turn (Undo/Restore, own edits), told to her once. */
    novaOwnerNotes?: string[];
    /** The owner's request being worked on right now, persisted so a restart can pick it up again. */
    /** What the owner actually wrote for the first build (Nova OS sends a composed brief as the query). */
    novaFirstLabel?: string;
    /** Commits left out of History on purpose (old test edits), by hash. */
    novaHiddenHistory?: string[];
    /** Nova's final reply for each finished change (commit hash → her words), so a reload shows it. */
    novaReplies?: Record<string, string>;
    novaActiveTurn?: { request: string; startedAt: number; lastProgressAt: number; resumes: number };
}

export type AgentState = PhasicState | AgenticState | ThinkState;
