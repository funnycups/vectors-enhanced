/**
 * @file StorageAdapter.js
 * @description 存储适配器，封装所有向量存储相关的操作
 * @module infrastructure/storage/StorageAdapter
 */

import { Logger } from '../../utils/Logger.js';

const logger = new Logger('StorageAdapter');

/**
 * 存储适配器类
 * 封装所有与向量存储相关的API调用
 */
export class StorageAdapter {
    constructor(dependencies = {}) {
        this.baseUrl = '/api/vector';
        // 依赖注入，避免循环引用
        this.getRequestHeaders = dependencies.getRequestHeaders;
        this.getVectorsRequestBody = dependencies.getVectorsRequestBody;
        this.throwIfSourceInvalid = dependencies.throwIfSourceInvalid;
        this.cachedVectors = dependencies.cachedVectors;
        
        logger.log('StorageAdapter initialized');
    }

    /**
     * 获取集合中保存的哈希值列表
     * @param {string} collectionId 集合ID
     * @returns {Promise<number[]>} 哈希值数组
     */
    async getSavedHashes(collectionId) {
        try {
            logger.log(`Getting saved hashes for collection: ${collectionId}`);
            
            const response = await fetch(`${this.baseUrl}/list`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionId: collectionId,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to get saved hashes for collection ${collectionId}`);
            }

            const hashes = await response.json();
            logger.log(`Retrieved ${hashes.length} hashes for collection ${collectionId}`);
            return hashes;
        } catch (error) {
            logger.error(`Error getting saved hashes: ${error.message}`);
            throw error;
        }
    }

    /**
     * 插入向量项到集合中
     * @param {string} collectionId 集合ID
     * @param {object[]} items 要插入的项
     * @param {AbortSignal} signal 可选的中断信号
     * @param {Object} options 额外选项
     * @param {boolean} options.skipDeduplication 是否跳过去重检查
     * @returns {Promise<void>}
     */
    async insertVectorItems(collectionId, items, signal = null, options = {}) {
        try {
            logger.log(`Inserting ${items.length} items into collection: ${collectionId}`);
            
            this.throwIfSourceInvalid();

            const response = await fetch(`${this.baseUrl}/insert`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionId: collectionId,
                    items: items,
                    skipDeduplication: options.skipDeduplication || false,
                }),
                signal: signal,
            });

            if (!response.ok) {
                throw new Error(`Failed to insert vector items for collection ${collectionId}`);
            }

            logger.log(`Successfully inserted ${items.length} items`);
        } catch (error) {
            if (error.name === 'AbortError') {
                logger.log('Insert operation was aborted');
            } else {
                logger.error(`Error inserting vector items: ${error.message}`);
            }
            throw error;
        }
    }

    /**
     * 批量查询多个集合 - 使用 SillyTavern 的 query-multi 端点
     * @param {string[]} collectionIds 集合ID数组
     * @param {string} searchText 搜索文本
     * @param {number} topK 返回结果数量
     * @param {number} threshold 相似度阈值
     * @returns {Promise<Record<string, {hashes: number[], metadata: object[], items?: object[]}>>}
     */
    async queryMultipleCollections(collectionIds, searchText, topK, threshold = 0.25) {
        try {
            logger.log(`Batch querying ${collectionIds.length} collections with text: "${searchText.substring(0, 50)}..."`);

            const response = await fetch(`${this.baseUrl}/query-multi`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionIds: collectionIds,
                    searchText: searchText,
                    topK: topK,
                    threshold: threshold,
                    includeText: true,
                }),
            });

            if (!response.ok) {
                // 如果批量查询端点不存在，返回 null 让调用者回退到单个查询
                if (response.status === 404) {
                    logger.warn('Batch query endpoint not available, falling back to individual queries');
                    return null;
                }
                throw new Error(`Failed to batch query collections`);
            }

            const results = await response.json();
            logger.log(`Batch query completed, returned results for ${Object.keys(results).length} collections`);

            // 处理每个集合的结果，解码元数据
            for (const collectionId in results) {
                const collectionResult = results[collectionId];
                if (collectionResult.metadata && Array.isArray(collectionResult.metadata)) {
                    collectionResult.metadata = collectionResult.metadata.map(item => {
                        if (item.text) {
                            const decoded = this.decodeMetadataFromText(item.text);
                            return {
                                ...item,
                                text: decoded.text,
                                decodedType: decoded.metadata.type,
                                decodedOriginalIndex: decoded.metadata.originalIndex
                            };
                        }
                        return item;
                    });

                    // 转换为统一的 items 格式，并尝试从多个位置获取分数
                    collectionResult.items = collectionResult.metadata.map((meta, idx) => {
                        // 尝试从多个可能的位置获取分数（参考原实现）
                        let score = 0;

                        // 1. 从 metadata 中获取分数
                        if (meta.score !== undefined) {
                            score = meta.score;
                        }
                        // 2. 从 distances 数组获取（如果存在）
                        else if (collectionResult.distances && collectionResult.distances[idx] !== undefined) {
                            // 距离越小越相似，转换为相似度分数
                            score = 1 / (1 + collectionResult.distances[idx]);
                        }
                        // 3. 从 similarities 数组获取（如果存在）
                        else if (collectionResult.similarities && collectionResult.similarities[idx] !== undefined) {
                            score = collectionResult.similarities[idx];
                        }
                        // 4. 默认为 0（如原实现）

                        return {
                            hash: collectionResult.hashes[idx],
                            text: meta.text,
                            score: score,
                            metadata: meta
                        };
                    });

                    // 如果存在 distances 或 similarities，记录到日志
                    if (collectionResult.distances || collectionResult.similarities) {
                        logger.log(`Collection ${collectionId} has additional score data:`, {
                            hasDistances: !!collectionResult.distances,
                            hasSimilarities: !!collectionResult.similarities
                        });
                    }
                }
            }

            return results;
        } catch (error) {
            logger.error(`Error in batch query: ${error.message}`);

            // 对于任何错误，返回 null 让调用者回退到单个查询
            return null;
        }
    }

    /**
     * 查询集合
     * @param {string} collectionId 集合ID
     * @param {string} searchText 搜索文本
     * @param {number} topK 返回结果数量
     * @param {number} threshold 相似度阈值
     * @returns {Promise<{hashes: number[], metadata: object[], items?: object[]}>}
     */
    async queryCollection(collectionId, searchText, topK, threshold = 0.25) {
        try {
            logger.log(`Querying collection ${collectionId} with text: "${searchText.substring(0, 50)}..."`);
            
            const response = await fetch(`${this.baseUrl}/query`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionId: collectionId,
                    searchText: searchText,
                    topK: topK,
                    threshold: threshold,
                    includeText: true,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to query collection ${collectionId}`);
            }

            const result = await response.json();
            logger.log(`Query returned ${result.hashes?.length || result.items?.length || 0} results`);
            
            // 添加调试日志查看返回的完整结构
            if (result && (result.hashes?.length > 0 || result.items?.length > 0)) {
                logger.log('Query result structure:', {
                    hasHashes: !!result.hashes,
                    hasMetadata: !!result.metadata,
                    hasItems: !!result.items,
                    hasDistances: !!result.distances,
                    hasSimilarities: !!result.similarities,
                    keys: Object.keys(result)
                });
                
                // 如果有距离数组，显示前几个值
                if (result.distances && result.distances.length > 0) {
                    logger.log('First 3 distances:', result.distances.slice(0, 3));
                }
            }
            
            // Decode metadata from text field if present
            if (result.metadata && Array.isArray(result.metadata)) {
                result.metadata = result.metadata.map(item => {
                    if (item.text) {
                        const decoded = this.decodeMetadataFromText(item.text);
                        return {
                            ...item,
                            text: decoded.text,
                            decodedType: decoded.metadata.type,
                            decodedOriginalIndex: decoded.metadata.originalIndex
                        };
                    }
                    return item;
                });
            }
            
            return result;
        } catch (error) {
            logger.error(`Error querying collection: ${error.message}`);
            throw error;
        }
    }

    /**
     * 获取特定哈希值的文本内容
     * 注意：SillyTavern没有/retrieve端点，但文本存储在query结果的metadata中
     * @param {string} collectionId 集合ID
     * @param {number[]} hashes 哈希值数组
     * @returns {Promise<Array>} {hash, text, metadata} 对象数组
     */
    async getVectorTexts(collectionId, hashes) {
        try {
            logger.log(`Retrieving texts for ${hashes.length} hashes from collection: ${collectionId}`);
            
            // SillyTavern没有专门的retrieve端点，但我们可以通过query获取metadata中的文本
            // 使用一个无关的搜索词来获取所有项目的metadata
            const response = await fetch(`${this.baseUrl}/query`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionId: collectionId,
                    searchText: "", // 使用空字符串而不是虚假搜索词
                    topK: 999999, // 增加到足够大的值
                    threshold: -1.0, // 使用负值确保接受所有结果
                    includeText: true,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to retrieve texts for collection ${collectionId}`);
            }

            const result = await response.json();
            logger.log(`Retrieved metadata for ${result.metadata?.length || 0} items`);
            
            // 过滤并格式化结果，只返回请求的哈希值
            const texts = [];
            if (result.metadata && Array.isArray(result.metadata)) {
                for (const metadata of result.metadata) {
                    if (hashes.includes(metadata.hash)) {
                        // 只添加有实际文本内容的项目
                        if (metadata.text && metadata.text.trim()) {
                            // Decode metadata from text
                            const decoded = this.decodeMetadataFromText(metadata.text);
                            texts.push({
                                hash: metadata.hash,
                                text: decoded.text,
                                metadata: {
                                    ...metadata,
                                    decodedType: decoded.metadata.type,
                                    decodedOriginalIndex: decoded.metadata.originalIndex
                                }
                            });
                        }
                    }
                }
            }
            
            logger.log(`Filtered and retrieved ${texts.length} texts matching requested hashes`);
            return texts;
        } catch (error) {
            logger.error(`Error retrieving texts: ${error.message}`);
            return [];
        }
    }

    /**
     * 清除向量索引
     * @param {string} collectionId 集合ID
     * @returns {Promise<boolean>} 是否成功
     */
    async purgeVectorIndex(collectionId) {
        try {
            logger.log(`Purging vector index for collection: ${collectionId}`);
            
            const response = await fetch(`${this.baseUrl}/purge`, {
                method: 'POST',
                headers: this.getRequestHeaders(),
                body: JSON.stringify({
                    ...this.getVectorsRequestBody(),
                    collectionId: collectionId,
                }),
            });

            if (!response.ok) {
                throw new Error(`Could not delete vector index for collection ${collectionId}`);
            }

            // 清除缓存
            if (this.cachedVectors && this.cachedVectors.delete) {
                this.cachedVectors.delete(collectionId);
            }
            
            logger.log(`Successfully purged vector index for ${collectionId}`);
            return true;
        } catch (error) {
            logger.error(`Error purging vector index: ${error.message}`);
            return false;
        }
    }

    /**
     * 检查集合是否存在
     * @param {string} collectionId 集合ID
     * @returns {Promise<boolean>} 是否存在
     */
    async collectionExists(collectionId) {
        try {
            const hashes = await this.getSavedHashes(collectionId);
            return hashes && hashes.length > 0;
        } catch (error) {
            // 如果获取失败，假设集合不存在
            return false;
        }
    }

    /**
     * 获取集合统计信息
     * @param {string} collectionId 集合ID
     * @returns {Promise<{count: number, exists: boolean}>}
     */
    async getCollectionStats(collectionId) {
        try {
            const hashes = await this.getSavedHashes(collectionId);
            return {
                exists: true,
                count: hashes.length
            };
        } catch (error) {
            return {
                exists: false,
                count: 0
            };
        }
    }

    /**
     * Decode metadata from encoded text
     * @param {string} encodedText - Text with metadata prefix
     * @returns {{text: string, metadata: {type?: string, originalIndex?: number, floor?: number, entry?: string, tag?: string, chunk?: string}}}
     * @private
     */
    decodeMetadataFromText(encodedText) {
        if (!encodedText) {
            return { text: encodedText, metadata: {} };
        }
        
        const metaMatch = encodedText.match(/^\[META:([^\]]+)\]/);
        if (!metaMatch) {
            return { text: encodedText, metadata: {} };
        }
        
        const metaString = metaMatch[1];
        const text = encodedText.substring(metaMatch[0].length);
        const metadata = {};
        
        // Parse metadata key-value pairs
        const pairs = metaString.split(',');
        for (const pair of pairs) {
            const [key, value] = pair.split('=');
            if (key && value) {
                if (key === 'originalIndex' || key === 'floor') {
                    metadata[key] = parseInt(value, 10);
                } else {
                    metadata[key] = value;
                }
            }
        }
        
        return { text, metadata };
    }
}