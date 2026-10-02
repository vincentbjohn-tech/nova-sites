import { GitVersionControl } from "../git";
import { DeploymentManager } from "../services/implementations/DeploymentManager";
import { FileManager } from "../services/implementations/FileManager";
import { StructuredLogger } from "../../logger";
import { BaseProjectState } from "./state";
import { WebSocketMessageType } from "../../api/websocketTypes";
import { WebSocketMessageData } from "../../api/websocketTypes";
import { ConversationMessage, ConversationState } from "../inferutils/common";
import { TemplateDetails } from "worker/services/sandbox/sandboxTypes";

/**
 * Infrastructure interface for agent implementations.
 * Provides access to:
 * - Core infrastructure (state, env, sql, logger)
 * - Services (fileManager, deploymentManager, git)
 */
export interface AgentInfrastructure<TState extends BaseProjectState> {
    readonly state: TState;
    setState(state: TState): void;
    getWebSockets(): WebSocket[];
    broadcast<T extends WebSocketMessageType>(
        type: T, 
        data?: WebSocketMessageData<T>
    ): void;
    getAgentId(): string;
    logger(): StructuredLogger;
    readonly env: Env;

    setConversationState(state: ConversationState): void;
    getConversationState(): ConversationState;
    addConversationMessage(message: ConversationMessage): void;
    clearConversation(): void;
    /** Nova Sites: a persisted one-minute check while a request is being worked on (survives restarts). */
    novaWatch(on: boolean): Promise<void>;
    /** Resolves once start-up's slow, generation-only reads (user model settings) are in. */
    novaReady(): Promise<void>;
    
    // Services
    readonly fileManager: FileManager;
    readonly deploymentManager: DeploymentManager;
    readonly git: GitVersionControl;

    // Git export infrastructure
    exportGitObjects(): Promise<{
        gitObjects: Array<{ path: string; data: Uint8Array }>;
        query: string;
        hasCommits: boolean;
        templateDetails: TemplateDetails | null;
    }>;
}
