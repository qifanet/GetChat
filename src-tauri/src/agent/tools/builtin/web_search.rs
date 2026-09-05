/**
 * @file agent/tools/builtin/web_search.rs
 * @description `web_search` tool (DuckDuckGo HTML scraping). Verbatim
 * relocation from services/tool_executor.rs (M2.1).
 */

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "web_search".to_string(),
            description: "Search the web for information. Returns a list of relevant results with titles, URLs, and snippets. Use this tool when you need to find current information, facts, or references that are not in your training data.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return (1-10, default 5)"
                    }
                },
                "required": ["query"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 30_000,
        timeout_secs: 30,
    };

    executor.register_async(definition, META, |args, _context| {
        Box::pin(web_search_handler(args))
    });
}

async fn web_search_handler(args: Value) -> ToolExecutionResult {
    let query = match args.get("query").and_then(Value::as_str) {
        Some(q) => q.trim().to_string(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: query".to_string(),
            };
        }
    };

    if query.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Search query cannot be empty".to_string(),
        };
    }

    let max_results = args
        .get("max_results")
        .and_then(Value::as_i64)
        .unwrap_or(5)
        .clamp(1, 10) as usize;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build();

    let client = match client {
        Ok(c) => c,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to create HTTP client: {e}"),
            };
        }
    };

    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(&query)
    );

    let response = match client.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Search request failed: {e}"),
            };
        }
    };

    let html = match response.text().await {
        Ok(t) => t,
        Err(e) => {
            return ToolExecutionResult {
                success: false,
                output: format!("Failed to read response: {e}"),
            };
        }
    };

    let document = match scraper::Html::parse_document(&html) {
        doc => doc,
    };

    let result_selector = match scraper::Selector::parse(".result") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse search results page structure".to_string(),
            };
        }
    };

    let title_selector = match scraper::Selector::parse(".result__title a") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse result title elements".to_string(),
            };
        }
    };

    let snippet_selector = match scraper::Selector::parse(".result__snippet") {
        Ok(s) => s,
        Err(_) => {
            return ToolExecutionResult {
                success: false,
                output: "Failed to parse result snippet elements".to_string(),
            };
        }
    };

    let mut results = Vec::new();

    for result_node in document.select(&result_selector).take(max_results) {
        let title = result_node
            .select(&title_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        let href = result_node
            .select(&title_selector)
            .next()
            .and_then(|el| el.value().attr("href"))
            .unwrap_or("");

        let snippet = result_node
            .select(&snippet_selector)
            .next()
            .map(|el| el.text().collect::<String>().trim().to_string())
            .unwrap_or_default();

        if !title.is_empty() {
            results.push(json!({
                "title": title,
                "url": href,
                "snippet": snippet,
            }));
        }
    }

    if results.is_empty() {
        return ToolExecutionResult {
            success: true,
            output: format!("No results found for: {query}"),
        };
    }

    let output = serde_json::to_string_pretty(&json!({
        "query": query,
        "results": results,
    }))
    .unwrap_or_else(|_| "Error formatting results".to_string());

    ToolExecutionResult {
        success: true,
        output,
    }
}
