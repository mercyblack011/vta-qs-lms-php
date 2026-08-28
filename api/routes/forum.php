<?php
// Mirrors src/routes/forum.js. $method and $segments are set by api/index.php.

function can_edit_thread(array $user, array $thread): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    return $thread['author_id'] == $user['id'];
}

if ($method === 'GET' && $segments === ['threads']) {
    $me = require_auth();
    $rows = query('
        SELECT t.*, u.name AS author_name,
          (SELECT COUNT(*) FROM forum_replies r WHERE r.thread_id = t.id) AS reply_count
        FROM forum_threads t JOIN users u ON u.id = t.author_id
        ORDER BY t.created_at DESC
    ');
    foreach ($rows as &$t) $t['can_edit'] = can_edit_thread($me, $t);
    unset($t);
    json_response(['threads' => $rows]);
}

if ($method === 'POST' && $segments === ['threads']) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $title = trim($body['title'] ?? '');
    if (!$title) error_response('title is required');
    $info = run('INSERT INTO forum_threads (title, body, author_id) VALUES (?, ?, ?)', [$title, $body['body'] ?? '', $me['id']]);
    $thread = query('SELECT * FROM forum_threads WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['thread' => $thread], 201);
}

if ($method === 'PUT' && count($segments) === 2 && $segments[0] === 'threads' && ctype_digit($segments[1])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $thread = query('SELECT * FROM forum_threads WHERE id = ?', [$segments[1]])[0] ?? null;
    if (!$thread) error_response('Announcement not found', 404);
    if (!can_edit_thread($me, $thread)) error_response('You can only edit announcements you created', 403);

    $body = request_body();
    $title = trim($body['title'] ?? '');
    if (!$title) error_response('title is required');
    run('UPDATE forum_threads SET title = ?, body = ? WHERE id = ?', [$title, $body['body'] ?? '', $thread['id']]);
    $updated = query('SELECT * FROM forum_threads WHERE id = ?', [$thread['id']])[0];
    json_response(['thread' => $updated]);
}

if ($method === 'GET' && count($segments) === 3 && $segments[0] === 'threads' && ctype_digit($segments[1]) && $segments[2] === 'replies') {
    require_auth();
    $rows = query('
        SELECT r.*, u.name AS author_name FROM forum_replies r
        JOIN users u ON u.id = r.author_id
        WHERE r.thread_id = ? ORDER BY r.created_at ASC
    ', [$segments[1]]);
    json_response(['replies' => $rows]);
}

if ($method === 'POST' && count($segments) === 3 && $segments[0] === 'threads' && ctype_digit($segments[1]) && $segments[2] === 'replies') {
    $me = require_auth();
    $thread = query('SELECT * FROM forum_threads WHERE id = ?', [$segments[1]])[0] ?? null;
    if (!$thread) error_response('Thread not found', 404);
    $body = trim(request_body()['body'] ?? '');
    if (!$body) error_response('body is required');
    $info = run('INSERT INTO forum_replies (thread_id, author_id, body) VALUES (?, ?, ?)', [$thread['id'], $me['id'], $body]);
    $reply = query('SELECT * FROM forum_replies WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['reply' => $reply], 201);
}

error_response('Not found', 404);
