<?php
// Mirrors src/routes/resources.js. $method and $segments are set by api/index.php.

function resource_lecturer_covers_module(?array $lecturerRow, array $resource): bool {
    if (!$lecturerRow) return false;
    if (!$resource['module']) return true;
    $modules = json_decode($lecturerRow['modules'] ?? '[]', true) ?: [];
    foreach ($modules as $m) if (($m['module'] ?? null) === $resource['module']) return true;
    return false;
}

function can_manage_resource(array $user, array $resource): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    if ($resource['uploaded_by'] == $user['id']) return true;
    $lecturer = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$user['id'], $resource['course_id']])[0] ?? null;
    return resource_lecturer_covers_module($lecturer, $resource);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    $type = $_GET['type'] ?? null;
    $courseId = $_GET['course_id'] ?? null;
    $module = $_GET['module'] ?? null;
    $clauses = [];
    $params = [];
    if ($type) { $clauses[] = 'r.type = ?'; $params[] = $type; }
    if ($courseId) { $clauses[] = 'r.course_id = ?'; $params[] = $courseId; }
    if ($module) { $clauses[] = 'r.module = ?'; $params[] = $module; }
    $where = $clauses ? 'WHERE ' . implode(' AND ', $clauses) : '';

    $rows = query("
        SELECT r.*, c.name AS course_name, u.name AS uploaded_by_name
        FROM resources r
        LEFT JOIN courses c ON c.id = r.course_id
        JOIN users u ON u.id = r.uploaded_by
        $where
        ORDER BY r.created_at DESC
    ", $params);

    $myLecturerRows = [];
    if ($me['role'] === 'instructor') {
        $myLecturerRows = query('SELECT course_id, modules FROM lecturers WHERE user_id = ?', [$me['id']]);
    }
    foreach ($rows as &$r) {
        if ($me['role'] === 'admin') { $r['can_delete'] = true; continue; }
        if ($me['role'] !== 'instructor') { $r['can_delete'] = false; continue; }
        if ($r['uploaded_by'] == $me['id']) { $r['can_delete'] = true; continue; }
        $lecturerRow = null;
        foreach ($myLecturerRows as $l) if ($l['course_id'] == $r['course_id']) { $lecturerRow = $l; break; }
        $r['can_delete'] = resource_lecturer_covers_module($lecturerRow, $r);
    }
    unset($r);

    json_response(['resources' => array_values($rows)]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $file = handle_upload('file', 'resources', ['application/pdf'], 15 * 1024 * 1024, 'PDF files');
    $body = request_body();
    $type = $body['type'] ?? null;
    $courseId = $body['course_id'] ?? null;
    $module = $body['module'] ?? null;
    $unitName = trim($body['unit_name'] ?? '');

    if (!in_array($type, ['notes', 'past_paper'], true)) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('type must be notes or past_paper');
    }
    if (!$unitName) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('unit_name is required');
    }
    if (!$file) error_response('Please attach a PDF file');

    if ($me['role'] === 'instructor') {
        $lecturerRow = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId ?: null])[0] ?? null;
        if (!resource_lecturer_covers_module($lecturerRow, ['module' => $module ?: null])) {
            delete_uploaded_file($file['path']);
            error_response('You can only upload files for a course and module you are assigned to teach.', 403);
        }
    }

    $info = run(
        'INSERT INTO resources (type, course_id, module, unit_name, file_path, file_name, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$type, $courseId ?: null, $module ?: null, $unitName, $file['path'], $file['name'], $me['id']]
    );
    $resource = query('
        SELECT r.*, c.name AS course_name, u.name AS uploaded_by_name
        FROM resources r LEFT JOIN courses c ON c.id = r.course_id JOIN users u ON u.id = r.uploaded_by
        WHERE r.id = ?
    ', [$info['lastInsertRowid']])[0];
    json_response(['resource' => $resource], 201);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $resource = query('SELECT * FROM resources WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$resource) error_response('File not found', 404);
    if (!can_manage_resource($me, $resource)) {
        error_response('You can only remove files for a course and module you are assigned to teach.', 403);
    }
    run('DELETE FROM resources WHERE id = ?', [$resource['id']]);
    json_response(['message' => 'File removed']);
}

error_response('Not found', 404);
