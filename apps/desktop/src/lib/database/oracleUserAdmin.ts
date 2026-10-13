import type { DatabaseUserAdminProvider, PrivilegeChangeInput, PrivilegeScope } from "./databaseUserAdmin";
import type { OracleSecuritySnapshot } from "./oracleSecurity";

type PrincipalKind = "user" | "role" | "public";
type Actions = Pick<DatabaseUserAdminProvider, "alterPasswordSql" | "supportsOldPassword" | "alterLoginSql" | "grantPrivilegesSql" | "revokePrivilegesSql">;
const SYSTEM_PRIVILEGES = ["CREATE SESSION", "CREATE TABLE", "CREATE VIEW", "CREATE SEQUENCE", "CREATE PROCEDURE", "CREATE TRIGGER", "CREATE SYNONYM"];
const OBJECT_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "REFERENCES", "ALTER", "INDEX", "EXECUTE"];

function identifier(value: string, fromMetadata = false): string {
  const input = fromMetadata ? value : value.trim();
  const name = fromMetadata ? input : /^"[^"\0\r\n]+"$/.test(input) ? input.slice(1, -1) : /^[A-Za-z][A-Za-z0-9_$#]*$/.test(input) ? input.toUpperCase() : "";
  if (!name || /["\0\r\n]/.test(name) || name === "*") throw new Error("Invalid Oracle identifier; use an exact name, with double quotes for case-sensitive names");
  return `"${name}"`;
}

function passwordToken(value: string): string {
  if (!value || /["\0\r\n]/.test(value)) throw new Error("A password without double quotes, NUL or line breaks is required");
  return `"${value}"`;
}

export function oraclePasswordSql(user: string, password: string, oldPassword?: string): string {
  return `ALTER USER ${identifier(user, true)} IDENTIFIED BY ${passwordToken(password)}${oldPassword ? ` REPLACE ${passwordToken(oldPassword)}` : ""};`;
}

export function oraclePrivilegesForScope(scope: PrivilegeScope): readonly string[] {
  return scope === "system" ? SYSTEM_PRIVILEGES : scope === "table" ? OBJECT_PRIVILEGES : [];
}

export function oraclePrivilegeSql(kind: PrincipalKind, input: PrivilegeChangeInput, revoke = false): string {
  const scope = input.scope ?? "table";
  const principal = kind === "public" ? "PUBLIC" : identifier(input.user.user, true);
  if (!revoke && input.grantOption && (kind === "public" || (kind === "role" && scope === "table"))) throw new Error("This principal cannot receive the selected grant option");
  let privileges: string;
  if (scope === "role") {
    privileges = identifier(input.role ?? "");
    if (privileges === principal) throw new Error("A role cannot be granted to itself");
  } else {
    const allowed = oraclePrivilegesForScope(scope);
    if (!input.privileges.length || input.privileges.some((privilege) => !allowed.includes(privilege))) throw new Error("Select supported Oracle privileges");
    privileges = [...new Set(input.privileges)].join(", ");
  }
  const object = scope === "table" ? ` ON ${identifier(input.database)}.${identifier(input.table ?? "")}` : "";
  const option = !revoke && input.grantOption ? (scope === "table" ? " WITH GRANT OPTION" : " WITH ADMIN OPTION") : "";
  return `${revoke ? "REVOKE" : "GRANT"} ${privileges}${object} ${revoke ? "FROM" : "TO"} ${principal}${option};`;
}

export function createOracleUserAdminActions(snapshot: OracleSecuritySnapshot | undefined, name: string | undefined, supportsOldPassword: boolean): Actions | undefined {
  if (!snapshot || !name) return;
  const kind: PrincipalKind | undefined = name === "PUBLIC" ? "public" : snapshot.users.rows.some((user) => user.name === name) || snapshot.currentUser.rows.includes(name) ? "user" : snapshot.roles.rows.some((role) => role.name === name) ? "role" : undefined;
  if (!kind) return;
  return {
    supportsOldPassword,
    ...(kind === "user"
      ? {
          alterLoginSql: (_user, enabled) => `ALTER USER ${identifier(name, true)} ACCOUNT ${enabled ? "UNLOCK" : "LOCK"};`,
          ...(snapshot.currentUser.rows.length ? { alterPasswordSql: (_user, password, oldPassword) => oraclePasswordSql(name, password, supportsOldPassword ? oldPassword : undefined) } : {}),
        }
      : {}),
    grantPrivilegesSql: (input) => oraclePrivilegeSql(kind, { ...input, user: { user: name, host: "" } }),
    revokePrivilegesSql: (input) => oraclePrivilegeSql(kind, { ...input, user: { user: name, host: "" } }, true),
  };
}
