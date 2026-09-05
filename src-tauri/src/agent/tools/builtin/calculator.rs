/**
 * @file agent/tools/builtin/calculator.rs
 * @description Calculator tool with a hand-written recursive descent parser.
 *
 * Verbatim relocation from services/tool_executor.rs (M2.1) — the parser is
 * moved wholesale so its behavior is preserved bit-for-bit.
 */

use serde_json::{json, Value};

use crate::agent::tools::executor::{BuiltinToolExecutor, ToolExecutionResult};
use crate::agent::tools::registry::{ToolConcurrency, ToolMeta, ToolRisk};
use crate::dto::common::{ToolDefinitionDto, ToolFunctionDefDto};

/** Register the calculator tool. */
pub(crate) fn register(executor: &mut BuiltinToolExecutor) {
    let definition = ToolDefinitionDto {
        tool_type: "function".to_string(),
        function: ToolFunctionDefDto {
            name: "calculator".to_string(),
            description: "Evaluate a mathematical expression. Supports +, -, *, /, ^, parentheses, and basic functions (sin, cos, tan, sqrt, abs, log, ln, pi, e).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "The mathematical expression to evaluate, e.g. '2 + 3 * 4' or 'sqrt(144)'"
                    }
                },
                "required": ["expression"]
            }),
        },
    };

    const META: ToolMeta = ToolMeta {
        risk: ToolRisk::Low,
        concurrency: ToolConcurrency::Safe,
        max_output_chars: 2_000,
        timeout_secs: 5,
    };

    executor.register(definition, META, |args, _context| calculator_handler(args));
}

/**
 * Safe mathematical expression evaluator.
 *
 * Security: Only allows digits, operators (+, -, *, /, ^), parentheses,
 * decimal points, and whitelisted function/constant names.
 * Rejects any expression containing non-mathematical characters.
 */
fn calculator_handler(args: Value) -> ToolExecutionResult {
    let expression = match args.get("expression").and_then(Value::as_str) {
        Some(expr) => expr.trim(),
        None => {
            return ToolExecutionResult {
                success: false,
                output: "Missing required parameter: expression".to_string(),
            };
        }
    };

    if expression.is_empty() {
        return ToolExecutionResult {
            success: false,
            output: "Expression cannot be empty".to_string(),
        };
    }

    if !is_safe_expression(expression) {
        return ToolExecutionResult {
            success: false,
            output: "Expression contains disallowed characters. Only numbers, operators (+, -, *, /, ^), parentheses, and functions (sin, cos, tan, sqrt, abs, log, ln, pi, e) are allowed.".to_string(),
        };
    }

    match evaluate_expression(expression) {
        Ok(result) => ToolExecutionResult {
            success: true,
            output: format!("{expression} = {result}"),
        },
        Err(msg) => ToolExecutionResult {
            success: false,
            output: format!("Evaluation error: {msg}"),
        },
    }
}

/** Check that expression only contains safe mathematical characters. */
fn is_safe_expression(expr: &str) -> bool {
    let allowed = |c: char| -> bool {
        c.is_ascii_digit()
            || c == '.'
            || c == '+'
            || c == '-'
            || c == '*'
            || c == '/'
            || c == '^'
            || c == '('
            || c == ')'
            || c == ' '
            || c == ','
    };

    // First pass: check all characters are from allowed set or part of known names
    let lowered = expr.to_lowercase();
    let cleaned = lowered
        .replace("sin", "")
        .replace("cos", "")
        .replace("tan", "")
        .replace("sqrt", "")
        .replace("abs", "")
        .replace("log", "")
        .replace("ln", "")
        .replace("pi", "")
        .replace("e", "");

    cleaned.chars().all(allowed)
}

/**
 * Recursive descent parser for mathematical expressions.
 *
 * Grammar:
 *   expr     → term (('+' | '-') term)*
 *   term     → power (('*' | '/') power)*
 *   power    → unary ('^' power)?
 *   unary    → ('-' unary) | call
 *   call     → NUMBER | IDENT '(' expr (',' expr)* ')' | IDENT | '(' expr ')'
 */
fn evaluate_expression(input: &str) -> Result<f64, String> {
    let tokens = tokenize(input)?;
    let mut pos = 0;
    let result = parse_expr(&tokens, &mut pos)?;
    if pos < tokens.len() {
        return Err(format!("Unexpected token: {:?}", tokens[pos]));
    }
    Ok(result)
}

#[derive(Debug, Clone)]
enum Token {
    Number(f64),
    Op(String),
    Func(String),
    Const(String),
    LParen,
    RParen,
    Comma,
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let mut tokens = Vec::new();
    let mut chars = input.chars().peekable();

    while let Some(&c) = chars.peek() {
        match c {
            ' ' | '\t' => {
                chars.next();
            }
            '+' | '-' | '*' | '/' | '^' => {
                tokens.push(Token::Op(c.to_string()));
                chars.next();
            }
            '(' => {
                tokens.push(Token::LParen);
                chars.next();
            }
            ')' => {
                tokens.push(Token::RParen);
                chars.next();
            }
            ',' => {
                tokens.push(Token::Comma);
                chars.next();
            }
            '.' | '0'..='9' => {
                let mut num_str = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_digit() || d == '.' {
                        num_str.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let n: f64 = num_str.parse().map_err(|e| format!("Invalid number '{num_str}': {e}"))?;
                tokens.push(Token::Number(n));
            }
            c if c.is_ascii_alphabetic() => {
                let mut name = String::new();
                while let Some(&d) = chars.peek() {
                    if d.is_ascii_alphabetic() {
                        name.push(d);
                        chars.next();
                    } else {
                        break;
                    }
                }
                let lower = name.to_lowercase();
                match lower.as_str() {
                    "sin" | "cos" | "tan" | "sqrt" | "abs" | "log" | "ln" => {
                        tokens.push(Token::Func(lower));
                    }
                    "pi" => tokens.push(Token::Const("pi".to_string())),
                    "e" => tokens.push(Token::Const("e".to_string())),
                    other => return Err(format!("Unknown identifier: {other}")),
                }
            }
            other => return Err(format!("Unexpected character: {other}")),
        }
    }

    Ok(tokens)
}

fn parse_expr(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_term(tokens, pos)?;
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Token::Op(op) if op == "+" || op == "-" => {
                let op = op.clone();
                *pos += 1;
                let right = parse_term(tokens, pos)?;
                left = if op == "+" { left + right } else { left - right };
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_term(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let mut left = parse_power(tokens, pos)?;
    while *pos < tokens.len() {
        match &tokens[*pos] {
            Token::Op(op) if op == "*" || op == "/" => {
                let op = op.clone();
                *pos += 1;
                let right = parse_power(tokens, pos)?;
                left = if op == "*" {
                    left * right
                } else {
                    if right == 0.0 {
                        return Err("Division by zero".to_string());
                    }
                    left / right
                };
            }
            _ => break,
        }
    }
    Ok(left)
}

fn parse_power(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    let base = parse_unary(tokens, pos)?;
    if *pos < tokens.len() {
        if let Token::Op(op) = &tokens[*pos] {
            if op == "^" {
                *pos += 1;
                let exp = parse_power(tokens, pos)?; // right-associative
                return Ok(base.powf(exp));
            }
        }
    }
    Ok(base)
}

fn parse_unary(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    if *pos < tokens.len() {
        if let Token::Op(op) = &tokens[*pos] {
            if op == "-" {
                *pos += 1;
                let val = parse_unary(tokens, pos)?;
                return Ok(-val);
            }
        }
    }
    parse_call(tokens, pos)
}

fn parse_call(tokens: &[Token], pos: &mut usize) -> Result<f64, String> {
    if *pos >= tokens.len() {
        return Err("Unexpected end of expression".to_string());
    }

    match &tokens[*pos] {
        Token::Number(n) => {
            let val = *n;
            *pos += 1;
            Ok(val)
        }
        Token::Const(name) => {
            let val = match name.as_str() {
                "pi" => std::f64::consts::PI,
                "e" => std::f64::consts::E,
                _ => return Err(format!("Unknown constant: {name}")),
            };
            *pos += 1;
            Ok(val)
        }
        Token::Func(name) => {
            let func_name = name.clone();
            *pos += 1;
            // Expect '('
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::LParen) {
                return Err(format!("Expected '(' after function '{func_name}'"));
            }
            *pos += 1;

            let mut args_vec = Vec::new();
            if *pos < tokens.len() && !matches!(&tokens[*pos], Token::RParen) {
                args_vec.push(parse_expr(tokens, pos)?);
                while *pos < tokens.len() && matches!(&tokens[*pos], Token::Comma) {
                    *pos += 1;
                    args_vec.push(parse_expr(tokens, pos)?);
                }
            }

            // Expect ')'
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::RParen) {
                return Err(format!("Expected ')' after function '{func_name}' arguments"));
            }
            *pos += 1;

            apply_function(&func_name, &args_vec)
        }
        Token::LParen => {
            *pos += 1;
            let val = parse_expr(tokens, pos)?;
            if *pos >= tokens.len() || !matches!(&tokens[*pos], Token::RParen) {
                return Err("Expected ')'".to_string());
            }
            *pos += 1;
            Ok(val)
        }
        other => Err(format!("Unexpected token: {other:?}")),
    }
}

fn apply_function(name: &str, args: &[f64]) -> Result<f64, String> {
    match name {
        "sin" => {
            if args.len() != 1 { return Err("sin() requires exactly 1 argument".into()); }
            Ok(args[0].sin())
        }
        "cos" => {
            if args.len() != 1 { return Err("cos() requires exactly 1 argument".into()); }
            Ok(args[0].cos())
        }
        "tan" => {
            if args.len() != 1 { return Err("tan() requires exactly 1 argument".into()); }
            Ok(args[0].tan())
        }
        "sqrt" => {
            if args.len() != 1 { return Err("sqrt() requires exactly 1 argument".into()); }
            if args[0] < 0.0 { return Err("sqrt() argument must be non-negative".into()); }
            Ok(args[0].sqrt())
        }
        "abs" => {
            if args.len() != 1 { return Err("abs() requires exactly 1 argument".into()); }
            Ok(args[0].abs())
        }
        "log" => {
            if args.len() == 1 { return Ok(args[0].log10()); }
            if args.len() == 2 { return Ok(args[0].log(args[1])); }
            Err("log() requires 1 or 2 arguments".into())
        }
        "ln" => {
            if args.len() != 1 { return Err("ln() requires exactly 1 argument".into()); }
            Ok(args[0].ln())
        }
        _ => Err(format!("Unknown function: {name}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_basic_arithmetic() {
        assert_eq!(evaluate_expression("2 + 3").unwrap(), 5.0);
        assert_eq!(evaluate_expression("10 - 4").unwrap(), 6.0);
        assert_eq!(evaluate_expression("3 * 4").unwrap(), 12.0);
        assert_eq!(evaluate_expression("10 / 2").unwrap(), 5.0);
    }

    #[test]
    fn test_operator_precedence() {
        assert_eq!(evaluate_expression("2 + 3 * 4").unwrap(), 14.0);
        assert_eq!(evaluate_expression("(2 + 3) * 4").unwrap(), 20.0);
    }

    #[test]
    fn test_power() {
        assert_eq!(evaluate_expression("2 ^ 3").unwrap(), 8.0);
        assert_eq!(evaluate_expression("2 ^ 3 ^ 2").unwrap(), 512.0); // right-associative
    }

    #[test]
    fn test_unary_minus() {
        assert_eq!(evaluate_expression("-5 + 3").unwrap(), -2.0);
        assert_eq!(evaluate_expression("-(-3)").unwrap(), 3.0);
    }

    #[test]
    fn test_functions() {
        let result = evaluate_expression("sqrt(144)").unwrap();
        assert!((result - 12.0).abs() < 1e-10);

        let result = evaluate_expression("abs(-7)").unwrap();
        assert!((result - 7.0).abs() < 1e-10);
    }

    #[test]
    fn test_constants() {
        let result = evaluate_expression("pi").unwrap();
        assert!((result - std::f64::consts::PI).abs() < 1e-10);

        let result = evaluate_expression("2 * pi").unwrap();
        assert!((result - 2.0 * std::f64::consts::PI).abs() < 1e-10);
    }

    #[test]
    fn test_division_by_zero() {
        assert!(evaluate_expression("1 / 0").is_err());
    }

    #[test]
    fn test_unsafe_expression_rejected() {
        assert!(!is_safe_expression("system('rm -rf /')"));
        assert!(!is_safe_expression("eval('code')"));
        assert!(is_safe_expression("2 + 3 * sqrt(16)"));
    }
}
