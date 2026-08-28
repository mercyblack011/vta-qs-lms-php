<?php
// Mirrors src/routes/lectures.js. $method and $segments are set by api/index.php.

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    $rows = query('
        SELECT l.*, c.name AS course_name FROM lectures l
        JOIN courses c ON c.id = l.course_id
        ORDER BY l.scheduled_at IS NULL, l.scheduled_at ASC, l.created_at DESC
    ');

    if ($me['role'] === 'instructor') {
        $myCourseIds = array_column(query('SELECT course_id FROM lecturers WHERE user_id = ?', [$me['id']]), 'course_id');
        $rows = array_values(array_filter($rows, fn($l) => in_array($l['course_id'], $myCourseIds)));
    }
    json_response(['lectures' => $rows]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'admin');
    $body = request_body();
    $title = trim($body['title'] ?? '');
    $courseId = $body['course_id'] ?? null;
    if (!$title || !$courseId) error_response('title and course_id are required');
    if (!query('SELECT id FROM courses WHERE id = ?', [$courseId])) error_response('Course not found', 404);

    $info = run('INSERT INTO lectures (course_id, instructor_id, title, description, scheduled_at) VALUES (?, ?, ?, ?, ?)',
        [$courseId, $me['id'], $title, $body['description'] ?? '', $body['scheduled_at'] ?? null]);
    $lecture = query('SELECT l.*, c.name AS course_name FROM lectures l JOIN courses c ON c.id = l.course_id WHERE l.id = ?', [$info['lastInsertRowid']])[0];
    json_response(['lecture' => $lecture], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $lecture = query('SELECT * FROM lectures WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$lecture) error_response('Lecture not found', 404);

    $body = request_body();
    run('UPDATE lectures SET title = ?, course_id = ?, description = ?, scheduled_at = ? WHERE id = ?', [
        $body['title'] ?? $lecture['title'],
        $body['course_id'] ?? $lecture['course_id'],
        $body['description'] ?? $lecture['description'],
        array_key_exists('scheduled_at', $body) ? $body['scheduled_at'] : $lecture['scheduled_at'],
        $lecture['id'],
    ]);
    $updated = query('SELECT l.*, c.name AS course_name FROM lectures l JOIN courses c ON c.id = l.course_id WHERE l.id = ?', [$lecture['id']])[0];
    json_response(['lecture' => $updated]);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $info = run('DELETE FROM lectures WHERE id = ?', [$segments[0]]);
    if ($info['changes'] === 0) error_response('Lecture not found', 404);
    json_response(['message' => 'Lecture removed']);
}

error_response('Not found', 404);
