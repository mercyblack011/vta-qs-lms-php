<?php
// Mirrors src/routes/career.js. $method and $segments are set by api/index.php.

if ($method === 'GET' && $segments === []) {
    require_auth();
    json_response(['jobs' => query('SELECT * FROM jobs ORDER BY created_at DESC')]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $title = trim($body['title'] ?? '');
    $type = $body['type'] ?? null;
    if (!$title || !in_array($type, ['Internship', 'Vacancy'], true)) {
        error_response('title and type (Internship or Vacancy) are required');
    }
    $info = run('INSERT INTO jobs (title, type, location, closes_at, description, posted_by) VALUES (?, ?, ?, ?, ?, ?)',
        [$title, $type, $body['location'] ?? '', $body['closes_at'] ?? null, $body['description'] ?? '', $me['id']]);
    $job = query('SELECT * FROM jobs WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['job' => $job], 201);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $info = run('DELETE FROM jobs WHERE id = ?', [$segments[0]]);
    if ($info['changes'] === 0) error_response('Job not found', 404);
    json_response(['message' => 'Job removed']);
}

error_response('Not found', 404);
