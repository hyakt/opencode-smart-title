/**
 * Smart Title Plugin for OpenCode
 * 
 * Automatically generates meaningful session titles based on conversation content.
 * Uses OpenCode auth provider for unified authentication across all AI providers.
 * 
 * Configuration: ~/.config/opencode/smart-title.jsonc
 * Logs: ~/.config/opencode/logs/smart-title/YYYY-MM-DD.log
 * 
 * NOTE: ai package is lazily imported to avoid loading the 2.8MB package during
 * plugin initialization. The package is only loaded when title generation is needed.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { getConfig } from "./lib/config.js"
import { Logger } from "./lib/logger.js"
import { TITLE_PROMPT } from "./prompt.js"
import { join } from "path"
import { homedir } from "os"

// Type for OpenCode client object
interface OpenCodeClient {
    session: {
        messages: (params: { path: { id: string } }) => Promise<any>
        update: (params: { path: { id: string }, body: { title: string } }) => Promise<any>
        get: (params: { path: { id: string } }) => Promise<any>
        create: (params: { body: { parentID: string; title: string }; query?: { directory?: string } }) => Promise<any>
        prompt: (params: { path: { id: string }; query?: { directory?: string }; body: { agent?: string; model?: { providerID: string; modelID: string }; parts: Array<{ type: "text"; text: string }> } }) => Promise<any>
        delete: (params: { path: { id: string } }) => Promise<any>
    }
    tui: {
        showToast: (params: { body: { title: string, message: string, variant: "info" | "success" | "warning" | "error", duration: number } }) => Promise<any>
    }
}

// Conversation turn structure for context extraction
interface ConversationTurn {
    user: {
        text: string
        time: number
    }
    assistant?: {
        first: string
        last: string
        time: number
    }
}

interface MessagePart {
    type: string
    text?: string
    synthetic?: boolean
}

interface Message {
    info: {
        id: string
        role: "user" | "assistant" | "system"
        sessionID: string
        time: {
            created: number
            completed?: number
        }
        parentID?: string
    }
    parts: MessagePart[]
}

/**
 * Checks if a session is a subagent (child session)
 * Subagent sessions should skip title generation
 */
async function isSubagentSession(
    client: OpenCodeClient,
    sessionID: string,
    logger: Logger
): Promise<boolean> {
    try {
        const result = await client.session.get({ path: { id: sessionID } })

        if (result.data?.parentID) {
            logger.debug("subagent-check", "Detected subagent session, skipping title generation", {
                sessionID,
                parentID: result.data.parentID
            })
            return true
        }

        return false
    } catch (error: any) {
        logger.error("subagent-check", "Failed to check if session is subagent", {
            sessionID,
            error: error.message
        })
        return false
    }
}

// Track idle event count per session for threshold-based updates
const sessionIdleCount = new Map<string, number>()

/**
 * Extract only text content from message parts, excluding synthetic content
 */
function extractTextOnly(parts: MessagePart[]): string {
    // Only extract text parts, exclude synthetic content
    const textParts = parts.filter(
        part => part.type === "text" && !part.synthetic
    )

    return textParts
        .map(part => part.text || '')
        .join("\n")
        .trim()
}

/**
 * Extract smart context from conversation
 * Returns first and last assistant messages per turn to minimize token usage
 */
async function extractSmartContext(
    client: OpenCodeClient,
    sessionId: string,
    logger: Logger
): Promise<ConversationTurn[]> {

    logger.debug('context-extraction', 'Fetching session messages', { sessionId })

    // Get all messages
    const { data: messages } = await client.session.messages({
        path: { id: sessionId }
    })

    logger.debug('context-extraction', 'Messages fetched', {
        sessionId,
        totalMessages: messages.length
    })

    // Filter out system messages
    const conversationMessages = messages.filter(
        (msg: Message) => msg.info.role === "user" || msg.info.role === "assistant"
    )

    logger.debug('context-extraction', 'Filtered conversation messages', {
        sessionId,
        conversationMessages: conversationMessages.length
    })

    // Group into turns
    const turns: ConversationTurn[] = []
    let currentTurn: ConversationTurn | null = null
    let assistantMessagesInTurn: Array<{ text: string, time: number }> = []

    for (const msg of conversationMessages) {
        if (msg.info.role === "user") {
            // Save previous turn if exists
            if (currentTurn && assistantMessagesInTurn.length > 0) {
                currentTurn.assistant = {
                    first: assistantMessagesInTurn[0].text,
                    last: assistantMessagesInTurn[assistantMessagesInTurn.length - 1].text,
                    time: assistantMessagesInTurn[0].time
                }
                turns.push(currentTurn)
            }

            // Start new turn
            const userText = extractTextOnly(msg.parts)
            currentTurn = {
                user: {
                    text: userText,
                    time: msg.info.time.created
                }
            }
            assistantMessagesInTurn = []

        } else if (msg.info.role === "assistant") {
            // Collect assistant messages for this turn
            const assistantText = extractTextOnly(msg.parts)
            if (assistantText.length > 0) {
                assistantMessagesInTurn.push({
                    text: assistantText,
                    time: msg.info.time.created
                })
            }
        }
    }

    // Don't forget the last turn (might not have assistant response yet)
    if (currentTurn) {
        if (assistantMessagesInTurn.length > 0) {
            currentTurn.assistant = {
                first: assistantMessagesInTurn[0].text,
                last: assistantMessagesInTurn[assistantMessagesInTurn.length - 1].text,
                time: assistantMessagesInTurn[0].time
            }
        }

        // Include the turn even if it doesn't have an assistant response yet
        // This ensures the triggering user message is included in the context
        turns.push(currentTurn)
    }

    logger.debug('context-extraction', 'Extracted conversation turns', {
        sessionId,
        turnCount: turns.length
    })

    return turns
}

/**
 * Truncate text to specified length with ellipsis
 */
function truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text
    return text.substring(0, maxLength) + "..."
}

/**
 * Format conversation context for title generation
 */
function formatContextForTitle(turns: ConversationTurn[]): string {
    const formatted: string[] = []

    for (const turn of turns) {
        // Add user message
        formatted.push(`User: ${turn.user.text}`)
        formatted.push("") // Empty line for readability

        // Add assistant messages if they exist
        if (turn.assistant) {
            if (turn.assistant.first === turn.assistant.last) {
                // Only one message - don't duplicate
                formatted.push(`Assistant: ${turn.assistant.first}`)
            } else {
                // Multiple messages - show first and last
                formatted.push(`Assistant (initial): ${turn.assistant.first}`)
                formatted.push(`Assistant (final): ${turn.assistant.last}`)
            }
            formatted.push("") // Empty line between turns
        }
    }

    return formatted.join("\n")
}

/**
 * Clean AI-generated title
 */
function cleanTitle(raw: string): string {
    // Remove thinking tags
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "")

    // Get first non-empty line
    const lines = cleaned.split("\n").map(line => line.trim())
    cleaned = lines.find(line => line.length > 0) || "Untitled"

    // Truncate if too long
    if (cleaned.length > 100) {
        cleaned = cleaned.substring(0, 97) + "..."
    }

    return cleaned
}

/**
 * Parse model string "provider/model" into providerID and modelID
 */
function parseModel(configModel: string | undefined): { providerID: string; modelID: string } | null {
    if (!configModel) return null
    const parts = configModel.split('/')
    if (parts.length !== 2) return null
    return { providerID: parts[0], modelID: parts[1] }
}

/**
 * Extract assistant response text from session messages
 */
async function extractAssistantResponse(
    client: OpenCodeClient,
    sessionId: string,
    logger: Logger
): Promise<string | null> {
    const { data: messages } = await client.session.messages({ path: { id: sessionId } })
    const assistantMessages = messages?.filter(
        (msg: Message) => msg.info.role === "assistant"
    )
    if (!assistantMessages || assistantMessages.length === 0) return null

    const lastMessage = assistantMessages[assistantMessages.length - 1]
    return extractTextOnly(lastMessage.parts) || null
}

/**
 * Generate title from conversation context using AI via opencode subagent session
 */
async function generateTitleFromContext(
    context: string,
    configModel: string | undefined,
    logger: Logger,
    client: OpenCodeClient,
    parentSessionId: string,
    directory?: string,
    customPrompt?: string
): Promise<string | null> {
    const modelInfo = parseModel(configModel)
    let childSessionId: string | null = null

    try {
        logger.info('title-generation', 'Creating subagent session for title generation', {
            configModel,
            parentSessionId
        })

        // Create child session
        const createResponse = await client.session.create({
            body: { parentID: parentSessionId, title: "smart-title" },
            query: directory ? { directory } : undefined
        })

        const createdSession = createResponse?.data ?? createResponse
        childSessionId = typeof createdSession?.id === "string" ? createdSession.id : null

        if (!childSessionId) {
            logger.error('title-generation', 'Failed to create child session')
            return null
        }

        logger.debug('title-generation', 'Child session created', {
            childSessionId,
            model: configModel
        })

        const prompt = customPrompt || TITLE_PROMPT

        logger.debug('title-generation', 'Generating title via subagent', {
            contextLength: context.length,
            promptSource: customPrompt ? 'custom' : 'built-in'
        })

        // Send prompt to child session
        await client.session.prompt({
            path: { id: childSessionId },
            query: directory ? { directory } : undefined,
            body: {
                ...(modelInfo ? { model: modelInfo } : {}),
                parts: [{
                    type: "text",
                    text: `${prompt}\n\n<conversation>\n${context}\n</conversation>\n\nOutput the title now:`
                }]
            }
        })

        // Extract response
        const responseText = await extractAssistantResponse(client, childSessionId, logger)

        if (!responseText) {
            logger.warn('title-generation', 'No response from subagent')
            return null
        }

        const title = cleanTitle(responseText)

        logger.info('title-generation', 'Title generated successfully', {
            title,
            titleLength: title.length,
            rawLength: responseText.length
        })

        return title

    } catch (error: any) {
        logger.error('title-generation', 'Failed to generate title', {
            error: error.message,
            stack: error.stack
        })
        return null
    } finally {
        // Cleanup child session
        if (childSessionId) {
            try {
                await client.session.delete({ path: { id: childSessionId } })
                logger.debug('title-generation', 'Child session cleaned up', { childSessionId })
            } catch (cleanupError: any) {
                logger.debug('title-generation', 'Failed to clean up child session', {
                    childSessionId,
                    error: cleanupError.message
                })
            }
        }
    }
}

/**
 * Update session title with smart context
 */
async function updateSessionTitle(
    client: OpenCodeClient,
    sessionId: string,
    logger: Logger,
    config: ReturnType<typeof getConfig>,
    directory?: string
): Promise<void> {
    try {
        logger.info('update-title', 'Title update triggered', { sessionId })

        // Extract smart context
        const turns = await extractSmartContext(client, sessionId, logger)

        // Need at least one turn to generate title
        if (turns.length === 0) {
            logger.warn('update-title', 'No conversation turns found', { sessionId })
            return
        }

        logger.info('update-title', 'Context extracted', {
            sessionId,
            turnCount: turns.length
        })

        // Log truncated context for debugging
        for (const turn of turns) {
            logger.debug('update-title', 'Turn context', {
                user: truncate(turn.user.text, 100),
                hasAssistant: !!turn.assistant
            })
        }

        // Format context
        const context = formatContextForTitle(turns)

        // Generate title via subagent
        const newTitle = await generateTitleFromContext(
            context,
            config.model,
            logger,
            client,
            sessionId,
            directory,
            config.prompt
        )

        if (!newTitle) {
            logger.warn('update-title', 'Title generation returned null', { sessionId })
            return
        }

        logger.info('update-title', 'Updating session with new title', {
            sessionId,
            title: newTitle
        })

        // Update session
        await client.session.update({
            path: { id: sessionId },
            body: { title: newTitle }
        })

        logger.info('update-title', 'Session title updated successfully', {
            sessionId,
            title: newTitle
        })

    } catch (error: any) {
        logger.error('update-title', 'Failed to update session title', {
            sessionId,
            error: error.message,
            stack: error.stack
        })
    }
}

/**
 * Smart Title Plugin
 * Automatically updates session titles using AI and smart context selection
 */
const SmartTitlePlugin: Plugin = async (ctx) => {
    const config = getConfig(ctx)

    // Exit early if plugin is disabled
    if (!config.enabled) {
        return {}
    }

    const logger = new Logger(config.debug)
    const { client } = ctx

    logger.info('plugin', 'Smart Title plugin initialized', {
        enabled: config.enabled,
        debug: config.debug,
        model: config.model,
        updateThreshold: config.updateThreshold,
        globalConfigFile: join(homedir(), ".config", "opencode", "smart-title.jsonc"),
        projectConfigFile: ctx.directory ? join(ctx.directory, ".opencode", "smart-title.jsonc") : "N/A",
        logDirectory: join(homedir(), ".config", "opencode", "logs", "smart-title")
    })

    return {
        event: async ({ event }) => {
            // @ts-ignore - session.status is not yet in the SDK types
            if (event.type === "session.status" && event.properties.status.type === "idle") {
                // @ts-ignore
                const sessionId = event.properties.sessionID

                logger.debug('event', 'Session became idle', { sessionId })

                // Skip if this is a subagent session
                if (await isSubagentSession(client, sessionId, logger)) {
                    return
                }

                // Increment idle count for this session
                const currentCount = (sessionIdleCount.get(sessionId) || 0) + 1
                sessionIdleCount.set(sessionId, currentCount)

                logger.debug('event', 'Idle count updated', {
                    sessionId,
                    currentCount,
                    threshold: config.updateThreshold
                })

                // Only update title if we've reached the threshold
                if (currentCount % config.updateThreshold !== 0) {
                    logger.debug('event', 'Threshold not reached, skipping title update', {
                        sessionId,
                        currentCount,
                        threshold: config.updateThreshold
                    })
                    return
                }

                logger.info('event', 'Threshold reached, triggering title update for idle session', {
                    sessionId,
                    currentCount,
                    threshold: config.updateThreshold
                })

                // Fire and forget - don't block the event handler
                updateSessionTitle(client, sessionId, logger, config, ctx.directory).catch((error) => {
                    logger.error('event', 'Title update failed', {
                        sessionId,
                        error: error.message,
                        stack: error.stack
                    })
                })
            }
        }
    }
}

export default SmartTitlePlugin
