<?php

function load_env(string $path): array {
    $env = [];
    if (is_file($path)) {
        foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) continue;
            [$key, $value] = explode('=', $line, 2);
            $env[trim($key)] = trim($value);
        }
    }
    return $env;
}

$GLOBALS['__env'] = load_env(__DIR__ . '/../../.env');

function env(string $key, $default = null) {
    return $GLOBALS['__env'][$key] ?? $default;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $host = env('DB_HOST', '127.0.0.1');
    $port = env('DB_PORT', '3306');
    $user = env('DB_USER', 'root');
    $password = env('DB_PASSWORD', '');
    $name = env('DB_NAME', 'vta_lms');

    $pdo = new PDO(
        "mysql:host=$host;port=$port;dbname=$name;charset=utf8mb4",
        $user,
        $password,
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]
    );
    return $pdo;
}

// Mirrors src/db.js's query(): SELECT and return all rows as assoc arrays.
function query(string $sql, array $params = []): array {
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchAll();
}

// Mirrors src/db.js's run(): INSERT/UPDATE/DELETE, returns lastInsertRowid/changes.
function run(string $sql, array $params = []): array {
    $stmt = db()->prepare($sql);
    $stmt->execute($params);
    return [
        'lastInsertRowid' => (int) db()->lastInsertId(),
        'changes' => $stmt->rowCount(),
    ];
}
