<?php
// Mirrors src/routes/lecturers.js. $method and $segments are set by api/index.php.

const LECTURER_SELECT = '
  SELECT l.*, c.name AS course_name
  FROM lecturers l LEFT JOIN courses c ON c.id = l.course_id
';

function clean_lecturer_modules($json): array {
    $list = json_decode($json ?: '[]', true);
    if (!is_array($list)) return [];
    $out = [];
    foreach ($list as $m) {
        $module = trim(is_array($m) ? ($m['module'] ?? '') : '');
        $code = trim(is_array($m) ? ($m['code'] ?? '') : '');
        if ($module) $out[] = ['module' => $module, 'code' => $code];
    }
    return $out;
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    json_response(['lecturers' => query(LECTURER_SELECT . ' ORDER BY l.id')]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'admin');
    $file = handle_upload('photo', 'lecturers', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    $body = request_body();
    $name = trim($body['name'] ?? '');
    $email = trim($body['email'] ?? '');
    $password = $body['password'] ?? '';

    if (!$name || !$email || !$password) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('name, email and password are required');
    }
    if (strlen($password) < 4) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('Password must be at least 4 characters');
    }

    $cleanEmail = strtolower($email);
    if (query('SELECT id FROM users WHERE email = ?', [$cleanEmail])) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('An account with this email already exists', 409);
    }

    $courseId = !empty($body['course_id']) ? (int) $body['course_id'] : null;
    if ($courseId && !query('SELECT id FROM courses WHERE id = ?', [$courseId])) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('Selected course not found', 404);
    }

    $hash = password_hash($password, PASSWORD_BCRYPT);
    $userId = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [$name, $cleanEmail, $hash, 'instructor'])['lastInsertRowid'];

    $photoUrl = $file ? $file['path'] : null;
    $lecturerId = run(
        'INSERT INTO lecturers (user_id, name, lecturer_id, course_id, modules, photo_url) VALUES (?, ?, ?, ?, ?, ?)',
        [$userId, $name, $body['lecturer_id'] ?? '', $courseId, json_encode(clean_lecturer_modules($body['modules'] ?? null)), $photoUrl]
    )['lastInsertRowid'];

    $lecturer = query(LECTURER_SELECT . ' WHERE l.id = ?', [$lecturerId])[0];
    json_response(['lecturer' => $lecturer], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $lecturer = query('SELECT * FROM lecturers WHERE id = ?', [$segments[0]])[0] ?? null;
    $file = handle_upload('photo', 'lecturers', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    if (!$lecturer) { if ($file) delete_uploaded_file($file['path']); error_response('Lecturer not found', 404); }

    $body = request_body();
    $courseId = $lecturer['course_id'];
    if (array_key_exists('course_id', $body)) {
        $courseId = !empty($body['course_id']) ? (int) $body['course_id'] : null;
        if ($courseId && !query('SELECT id FROM courses WHERE id = ?', [$courseId])) {
            if ($file) delete_uploaded_file($file['path']);
            error_response('Selected course not found', 404);
        }
    }

    $photoUrl = $file ? $file['path'] : $lecturer['photo_url'];
    $modulesJson = array_key_exists('modules', $body) ? json_encode(clean_lecturer_modules($body['modules'])) : $lecturer['modules'];

    run('UPDATE lecturers SET name = ?, lecturer_id = ?, course_id = ?, modules = ?, photo_url = ? WHERE id = ?', [
        $body['name'] ?? $lecturer['name'], $body['lecturer_id'] ?? $lecturer['lecturer_id'], $courseId, $modulesJson, $photoUrl, $lecturer['id'],
    ]);
    $updated = query(LECTURER_SELECT . ' WHERE l.id = ?', [$lecturer['id']])[0];
    json_response(['lecturer' => $updated]);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $info = run('DELETE FROM lecturers WHERE id = ?', [$segments[0]]);
    if ($info['changes'] === 0) error_response('Lecturer not found', 404);
    json_response(['message' => 'Lecturer removed']);
}

error_response('Not found', 404);
