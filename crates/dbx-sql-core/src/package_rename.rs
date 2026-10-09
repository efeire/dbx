//! Source preparation for guarded Oracle package renames. This module does not
//! execute DDL or authorize removal of the original package.

use crate::models::connection::DatabaseType;

#[derive(Debug, Clone, PartialEq)]
pub struct PackageRenameSources {
    pub original_specification: String,
    pub original_body: Option<String>,
    pub create_specification: String,
    pub create_body: Option<String>,
}

pub fn prepare_package_rename_sources(
    database_type: DatabaseType,
    owner: &str,
    name: &str,
    new_name: &str,
    specification: &str,
    body: Option<&str>,
) -> Result<PackageRenameSources, String> {
    if !matches!(database_type, DatabaseType::Oracle | DatabaseType::OceanbaseOracle) {
        return Err("Package source rename requires Oracle or OceanBase Oracle.".into());
    }
    if owner.is_empty() || name.is_empty() || new_name.is_empty() || name == new_name {
        return Err("A schema and two different nonempty package names are required.".into());
    }
    Ok(PackageRenameSources {
        original_specification: specification.to_owned(),
        original_body: body.map(str::to_owned),
        create_specification: rewrite_package(specification, owner, name, new_name, false)?,
        create_body: body.map(|source| rewrite_package(source, owner, name, new_name, true)).transpose()?,
    })
}

#[derive(Debug)]
struct Lexeme<'a> {
    start: usize,
    end: usize,
    text: &'a str,
    identifier: Option<String>,
}

impl Lexeme<'_> {
    fn keyword(&self, word: &str) -> bool {
        !self.text.starts_with('"') && self.text.eq_ignore_ascii_case(word)
    }
}

fn quoted(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn rewrite_package(source: &str, owner: &str, name: &str, new_name: &str, body: bool) -> Result<String, String> {
    let tokens = lex(source)?;
    let invalid = || "Package source declaration or final END does not match the selected object.".to_string();
    let is = |index: usize, word: &str| tokens.get(index).is_some_and(|token| token.keyword(word));
    if !is(0, "CREATE") {
        return Err(invalid());
    }
    let mut index = 1;
    let mut edits: Vec<(usize, usize, String)> = Vec::new();
    if is(index, "OR") {
        if !is(index + 1, "REPLACE") {
            return Err(invalid());
        }
        for token in &tokens[index..index + 2] {
            edits.push((token.start, token.end, String::new()));
        }
        index += 2;
    }
    if is(index, "EDITIONABLE") || is(index, "NONEDITIONABLE") {
        index += 1;
    }
    if !is(index, "PACKAGE") {
        return Err(invalid());
    }
    index += 1;
    if is(index, "BODY") != body {
        return Err(invalid());
    }
    if body {
        index += 1;
    }
    let first = tokens.get(index).ok_or_else(invalid)?;
    let mut declared_name = first.identifier.as_deref().ok_or_else(invalid)?;
    let name_start = first.start;
    let mut name_end = first.end;
    index += 1;
    if is(index, ".") {
        if declared_name != owner {
            return Err(invalid());
        }
        let second = tokens.get(index + 1).ok_or_else(invalid)?;
        declared_name = second.identifier.as_deref().ok_or_else(invalid)?;
        name_end = second.end;
        index += 2;
    }
    if declared_name != name {
        return Err(invalid());
    }
    edits.push((name_start, name_end, format!("{}.{}", quoted(owner), quoted(new_name))));

    let mut end = tokens.len();
    if end > 0 && is(end - 1, "/") {
        edits.push((tokens[end - 1].start, tokens[end - 1].end, String::new()));
        end -= 1;
    }
    if end < index + 2 || !is(end - 1, ";") {
        return Err(invalid());
    }
    let end_name = if is(end - 2, "END") {
        None
    } else if end >= 3 && is(end - 3, "END") && tokens[end - 2].identifier.as_deref() == Some(name) {
        Some(end - 2)
    } else {
        return Err(invalid());
    };
    if let Some(last) = end_name {
        edits.push((tokens[last].start, tokens[last].end, quoted(new_name)));
    }

    let owner_qualified_reference = tokens[index..end].windows(5).any(|window| {
        window[0].identifier.as_deref() == Some(owner)
            && window[1].text == "."
            && window[2].identifier.as_deref() == Some(name)
            && window[3].text == "."
    });
    if owner_qualified_reference
        && (index..end).any(|current| {
            tokens[current].identifier.as_deref() == Some(owner)
                && !is(current + 1, ".")
                && (current == 0 || !is(current - 1, "."))
        })
    {
        return Err("The schema qualifier may be shadowed by a local identifier; resolve it before renaming.".into());
    }

    for current in index..end {
        let token = &tokens[current];
        if token.identifier.as_deref() != Some(name) || Some(current) == end_name {
            continue;
        }
        if current > 0 && is(current - 1, ".") {
            // ExternalOwner.OldPackage.Member is unrelated. Only the selected
            // owner's exact qualification establishes a self-reference here.
            if current < 2 || tokens[current - 2].identifier.as_deref() != Some(owner) {
                continue;
            }
            if current >= 3 && is(current - 3, ".") {
                continue;
            }
        }
        if !is(current + 1, ".") || tokens.get(current + 2).and_then(|token| token.identifier.as_ref()).is_none() {
            return Err("A package-name identifier is used outside a proven self-reference; resolve shadowing manually before renaming.".into());
        }
        edits.push((token.start, token.end, quoted(new_name)));
    }
    edits.sort_by_key(|edit| edit.0);
    let mut result = source.to_owned();
    for (start, end, replacement) in edits.into_iter().rev() {
        result.replace_range(start..end, &replacement);
    }
    Ok(result)
}

/// Record byte spans while leaving comments and literals untouched. Reject an
/// unterminated token instead of making a partial rewrite of untrusted source.
fn lex(source: &str) -> Result<Vec<Lexeme<'_>>, String> {
    let mut result = Vec::new();
    let mut offset = 0;
    while offset < source.len() {
        let rest = &source[offset..];
        let ch = rest.chars().next().unwrap();
        if ch.is_whitespace() {
            offset += ch.len_utf8();
            continue;
        }
        if rest.starts_with("--") {
            offset += rest.find('\n').unwrap_or(rest.len());
            continue;
        }
        if rest.starts_with("/*") {
            offset += rest.find("*/").ok_or("Unterminated package source comment.")? + 2;
            continue;
        }
        let start = offset;
        let mut identifier = None;
        if (rest.starts_with("q'") || rest.starts_with("Q'")) && rest.len() > 2 {
            let delimiter = rest[2..].chars().next().unwrap();
            let close = match delimiter {
                '[' => ']',
                '(' => ')',
                '{' => '}',
                '<' => '>',
                other => other,
            };
            let content = 2 + delimiter.len_utf8();
            let marker = format!("{close}'");
            offset += content
                + rest[content..].find(&marker).ok_or("Unterminated alternative-quoted package literal.")?
                + marker.len();
        } else if ch == '\'' || ch == '"' {
            offset += 1;
            loop {
                let next = source[offset..].chars().next().ok_or("Unterminated quoted package token.")?;
                offset += next.len_utf8();
                if next != ch {
                    continue;
                }
                if source[offset..].starts_with(ch) {
                    offset += 1;
                    continue;
                }
                break;
            }
            if ch == '"' {
                identifier = Some(source[start + 1..offset - 1].replace("\"\"", "\""));
            }
        } else if ch.is_alphabetic() || ch == '_' {
            offset += ch.len_utf8();
            while let Some(next) = source[offset..].chars().next() {
                if !next.is_alphanumeric() && !matches!(next, '_' | '$' | '#') {
                    break;
                }
                offset += next.len_utf8();
            }
            identifier = Some(source[start..offset].to_uppercase());
        } else {
            offset += ch.len_utf8();
        }
        result.push(Lexeme { start, end: offset, text: &source[start..offset], identifier });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_source_snapshots_and_prepares_specification_without_a_body() {
        let source = "-- source\nCREATE OR /* keep */ REPLACE PACKAGE APP.PKG AS PROCEDURE RUN; END PKG;\n/";
        let plan = prepare_package_rename_sources(DatabaseType::OceanbaseOracle, "APP", "PKG", "NEW_PKG", source, None)
            .unwrap();
        assert_eq!(plan.original_specification, source);
        assert_eq!(plan.original_body, None);
        assert_eq!(plan.create_body, None);
        assert!(plan.create_specification.contains("CREATE  /* keep */  PACKAGE \"APP\".\"NEW_PKG\""));
        assert!(plan.create_specification.contains("END \"NEW_PKG\";"));
        assert!(!plan.create_specification.contains("DROP"));
    }

    #[test]
    fn rewrites_proven_self_references_but_preserves_external_references_and_literals() {
        let spec = "CREATE PACKAGE PKG AS PROCEDURE RUN; END;";
        let body = "CREATE OR REPLACE PACKAGE BODY PKG AS PROCEDURE RUN IS BEGIN PKG.NEXT; APP.PKG.NEXT; OTHER.PKG.NEXT; EXECUTE IMMEDIATE 'BEGIN PKG.NEXT; END;'; x := q'[PKG.NEXT '中文😀']'; -- PKG.NEXT\nEND RUN; END PKG;";
        let plan =
            prepare_package_rename_sources(DatabaseType::Oracle, "APP", "PKG", "NEW_PKG", spec, Some(body)).unwrap();
        let renamed = plan.create_body.unwrap();
        assert_eq!(plan.original_body.as_deref(), Some(body));
        assert!(renamed.contains("\"NEW_PKG\".NEXT; APP.\"NEW_PKG\".NEXT; OTHER.PKG.NEXT;"));
        assert!(renamed.contains("'BEGIN PKG.NEXT; END;'"));
        assert!(renamed.contains("q'[PKG.NEXT '中文😀']'"));
        assert!(renamed.contains("-- PKG.NEXT"));
        assert!(renamed.contains("END RUN; END \"NEW_PKG\";"));
    }

    #[test]
    fn handles_exact_quoted_owner_package_and_closing_name() {
        let source = "CREATE PACKAGE \"Mixed.Owner\".\"Pkg.Name\" AS PROCEDURE RUN; END \"Pkg.Name\";";
        let plan = prepare_package_rename_sources(
            DatabaseType::OceanbaseOracle,
            "Mixed.Owner",
            "Pkg.Name",
            "New\"Name",
            source,
            None,
        )
        .unwrap();
        assert!(plan.create_specification.contains("PACKAGE \"Mixed.Owner\".\"New\"\"Name\""));
        assert!(plan.create_specification.contains("END \"New\"\"Name\";"));
        assert!(prepare_package_rename_sources(DatabaseType::Oracle, "MIXED.OWNER", "Pkg.Name", "NEW", source, None)
            .is_err());
    }

    #[test]
    fn rejects_wrong_identity_kind_shadowing_and_incomplete_source() {
        for source in [
            "CREATE PACKAGE OTHER AS PROCEDURE RUN; END OTHER;",
            "CREATE PACKAGE BODY PKG AS PROCEDURE RUN; END PKG;",
            "CREATE PACKAGE PKG AS PKG NUMBER; END PKG;",
            "CREATE PACKAGE PKG AS APP NUMBER; x APP.PKG.T; END PKG;",
            "CREATE PACKAGE PKG AS PROCEDURE RUN; END WRONG;",
            "CREATE PACKAGE PKG AS x VARCHAR2(30) := 'unterminated; END;",
        ] {
            assert!(
                prepare_package_rename_sources(DatabaseType::Oracle, "APP", "PKG", "NEW", source, None).is_err(),
                "{source}"
            );
        }
    }
}
