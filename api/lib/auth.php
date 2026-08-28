<?php

// Stores {id, name, email, role} in the session - mirrors the JWT payload shape
// the Node app used to sign, minus the token itself.
function login_session(array $user): void {
    session_regenerate_id(true);
    $_SESSION['user'] = [
        'id' => (int) $user['id'],
        'name' => $user['name'],
        'email' => $user['email'],
        'role' => $user['role'],
    ];
}

function logout_session(): void {
    $_SESSION = [];
    session_destroy();
}

function current_user_or_null(): ?array {
    return $_SESSION['user'] ?? null;
}

function require_auth(): array {
    $user = current_user_or_null();
    if (!$user) error_response('Missing or invalid session - please log in', 401);
    return $user;
}

function require_role(array $user, string ...$roles): void {
    if (!in_array($user['role'], $roles, true)) {
        error_response('Forbidden: insufficient role', 403);
    }
}

// Strips password_hash before a user row is ever sent back to the client.
function public_user(array $user): array {
    unset($user['password_hash']);
    return $user;
}
