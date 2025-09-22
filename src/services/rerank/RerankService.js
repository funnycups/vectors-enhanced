import { RerankConfig } from './RerankConfig.js';

/**
 * Service class for handling document reranking
 */
export class RerankService {
    /**
     * @param {Object} settings - Global settings object
     * @param {Object} options - Additional options
     * @param {Function} options.toastr - Toast notification function
     */
    constructor(settings, options = {}) {
        this.config = new RerankConfig(settings);
        this.settings = settings; // Keep reference to settings for checking show_query_notification
        this.toastr = options.toastr || console;
        this.lastNotifyTime = 0;
        this.NOTIFICATION_COOLDOWN = 5000; // 5 seconds
    }

    /**
     * Check if rerank is enabled and properly configured
     * @returns {boolean}
     */
    isEnabled() {
        const config = this.config.getConfig();
        const validation = this.config.validateConfig();
        return config.enabled && validation.valid;
    }

    /**
     * Rerank search results
     * @param {string} query - Query text
     * @param {import('./RerankTypes.js').RerankItem[]} results - Array of search results
     * @returns {Promise<import('./RerankTypes.js').RerankItem[]>} Reranked results
     */
    async rerankResults(query, results) {
        if (!this.isEnabled() || results.length === 0) {
            return results;
        }

        const config = this.config.getConfig();
        console.debug('Vectors: Reranking enabled. Starting rerank process...');

        try {
            // Index results for tracking
            const indexedResults = results.map((result, index) => ({
                ...result,
                _rerank_index: index
            }));

            // Apply input limit to control cost (limit the number of candidates sent to API)
            const inputLimit = (config && typeof config.input_limit === 'number' && config.input_limit > 0)
                ? config.input_limit
                : Infinity;
            const limitedResults = indexedResults.slice(0, inputLimit);

            // Prepare documents for reranking (only limited subset is sent)
            const documentsToRerank = limitedResults.map((x, index) => ({
                text: x.text,
                // Keep mapping: local index within limited subset and original index
                index: index,
                originalIndex: x._rerank_index
            }));

            // Build rerank request
            const rerankRequest = this._buildRerankRequest(query, documentsToRerank, config);

            // Send rerank request
            const rerankResponse = await this._sendRerankRequest(config, rerankRequest);

            // Process response
            const rerankedResults = this._processRerankResponse(
                indexedResults,
                rerankResponse,
                config.hybrid_alpha,
                documentsToRerank
            );

            // Show notification if enabled
            this._showNotification(config, results.length, rerankedResults.length);

            return rerankedResults;

        } catch (error) {
            console.error('Vectors: Reranking failed. Falling back to original similarity search.', error);
            
            // Clean up any rerank-related properties
            const cleanedResults = results.map(result => {
                const { hybrid_score, rerank_score, original_score, _rerank_index, _rerank_success, ...originalResult } = result;
                return originalResult;
            });
            
            // Sort by original score
            cleanedResults.sort((a, b) => (b.score || 0) - (a.score || 0));
            
            this.toastr.error('Rerank失败，使用原始搜索结果。');
            return cleanedResults;
        }
    }

    /**
     * Build rerank request body
     * @private
     */
    _buildRerankRequest(query, documents, config) {
        const request = {
            query: query,
            documents: documents.map(x => x.text),
            model: config.model,
            top_n: Math.min(documents.length, config.top_n)
        };

        // Add deduplication instruction if enabled
        if (config.deduplication_enabled && config.deduplication_instruction) {
            request.instruct = config.deduplication_instruction;
            console.debug('Vectors: Using deduplication instruction for rerank');
        }

        return request;
    }

    /**
     * Send rerank request to API
     * @private
     */
    async _sendRerankRequest(config, requestBody) {
        const response = await fetch(config.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            throw new Error(`Rerank API failed: ${response.statusText}`);
        }

        const data = await response.json();
        console.debug('Vectors: Rerank API response:', data);
        return data;
    }

    /**
     * Process rerank response and calculate hybrid scores
     * @private
     */
    _processRerankResponse(indexedResults, rerankData, hybridAlpha, documentsToRerank = null) {
        if (!rerankData.results || !Array.isArray(rerankData.results)) {
            throw new Error('Unexpected rerank API response format');
        }

        // Build a map from original index to returned rerank score (only for limited subset)
        const rerankScoreByOriginalIndex = new Map();

        if (documentsToRerank && Array.isArray(documentsToRerank) && documentsToRerank.length > 0) {
            // Try to align response.results with documentsToRerank via 'index' or position
            documentsToRerank.forEach((doc, docArrayIndex) => {
                // Prefer match by explicit index
                const match = rerankData.results.find(r => r.index === doc.index) || rerankData.results[docArrayIndex] || null;
                let relevanceScore = 0;
                if (match && typeof match.relevance_score === 'number') relevanceScore = match.relevance_score;
                else if (match && typeof match.score === 'number') relevanceScore = match.score;
                rerankScoreByOriginalIndex.set(doc.originalIndex, relevanceScore);
            });
        }

        const rerankedResults = indexedResults.map((result, arrayIndex) => {
            let relevanceScore = 0;
            
            // If we sent a limited subset, prefer score from map; otherwise, try matching strategies
            if (rerankScoreByOriginalIndex.has(result._rerank_index)) {
                relevanceScore = rerankScoreByOriginalIndex.get(result._rerank_index) || 0;
            } else {
                // Fallback strategies remain for full-size submissions
                const rerankedResult = 
                    rerankData.results.find(r => r.index === result._rerank_index) ||
                    rerankData.results[arrayIndex] ||
                    (rerankData.results.length === indexedResults.length ? rerankData.results[arrayIndex] : null);
                if (rerankedResult && typeof rerankedResult.relevance_score === 'number') {
                    relevanceScore = rerankedResult.relevance_score;
                } else if (rerankedResult && typeof rerankedResult.score === 'number') {
                    relevanceScore = rerankedResult.score;
                }
            }
            
            // Calculate hybrid score
            const hybridScore = relevanceScore * hybridAlpha + result.score * (1 - hybridAlpha);
            
            // Remove temporary index property
            const { _rerank_index, ...cleanResult } = result;
            
            return {
                ...cleanResult,
                hybrid_score: hybridScore,
                rerank_score: relevanceScore,
                original_score: result.score,
                _rerank_success: relevanceScore > 0
            };
        });
        
        // Sort by hybrid score
        rerankedResults.sort((a, b) => (b.hybrid_score || 0) - (a.hybrid_score || 0));
        
        // Log statistics
        const successCount = rerankedResults.filter(r => r._rerank_success).length;
        console.debug(`Vectors: Rerank completed. ${successCount}/${rerankedResults.length} items successfully reranked`);
        
        // Log top results for debugging
        console.debug('Vectors: Top 5 results after rerank:', rerankedResults.slice(0, 5).map((r, i) => ({
            index: i,
            hybrid_score: r.hybrid_score?.toFixed(4),
            rerank_score: r.rerank_score?.toFixed(4),
            original_score: r.original_score?.toFixed(4),
            text_preview: r.text?.substring(0, 50) + '...'
        })));
        
        // Warn if no items were reranked successfully
        if (successCount === 0 && rerankedResults.length > 0) {
            console.warn('Vectors: No items were successfully reranked. API response format may be incompatible.');
        }
        
        return rerankedResults;
    }

    /**
     * Show rerank notification if enabled
     * @private
     */
    _showNotification(config, originalCount, rerankedCount) {
        // Skip notification if main query notification is enabled (to avoid duplicates)
        if (this.settings.show_query_notification) {
            console.debug('Vectors: Rerank notification skipped - main query notification is enabled');
            return;
        }

        if (!config.success_notify) {
            return;
        }

        const currentTime = Date.now();
        if (currentTime - this.lastNotifyTime < this.NOTIFICATION_COOLDOWN) {
            console.debug('Vectors: Rerank notification skipped due to cooldown');
            return;
        }

        this.toastr.info(
            `Rerank completed: ${originalCount} → ${rerankedCount} results`,
            'Rerank Success',
            { timeOut: 2000 }
        );

        this.lastNotifyTime = currentTime;
    }

    /**
     * Limit results based on configuration
     * @param {import('./RerankTypes.js').RerankItem[]} results - Reranked results
     * @param {number} maxResults - Maximum results from main query
     * @returns {import('./RerankTypes.js').RerankItem[]} Limited results
     */
    limitResults(results, maxResults) {
        const config = this.config.getConfig();
        const finalLimit = Math.min(config.top_n, maxResults);
        
        if (results.length > finalLimit) {
            console.debug(`Vectors: Limiting final results from ${results.length} to ${finalLimit}`);
            return results.slice(0, finalLimit);
        }
        
        return results;
    }
}