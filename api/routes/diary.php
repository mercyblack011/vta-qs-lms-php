<?php
// Mirrors src/routes/diary.js. $method and $segments are set by api/index.php.

const DIARY_SELECT = '
  SELECT d.*, c.name AS course_name FROM diary_entries d
  LEFT JOIN courses c ON c.id = d.course_id
';

function clean_diary_slots($slots): array {
    if (!is_array($slots)) return [];
    return array_map(fn($s) => [
        'time' => trim(is_array($s) ? ($s['time'] ?? '') : ''),
        'module' => trim(is_array($s) ? ($s['module'] ?? '') : ''),
        'task' => trim(is_array($s) ? ($s['task'] ?? '') : ''),
        'subject' => trim(is_array($s) ? ($s['subject'] ?? '') : ''),
        'signature' => trim(is_array($s) ? ($s['signature'] ?? '') : ''),
    ], $slots);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    $courseId = $_GET['course_id'] ?? null;
    $month = $_GET['month'] ?? null;
    $batch = $_GET['batch'] ?? null;
    $clauses = [];
    $params = [];
    if ($courseId) { $clauses[] = 'd.course_id = ?'; $params[] = $courseId; }
    if ($month && preg_match('/^\d{4}-\d{2}$/', $month)) { $clauses[] = "DATE_FORMAT(d.date, '%Y-%m') = ?"; $params[] = $month; }

    if ($me['role'] === 'student') {
        $myStudent = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        $batch = $myStudent ? $myStudent['batch'] : $batch;
    }
    if ($batch) { $clauses[] = '(d.batch IS NULL OR d.batch = ?)'; $params[] = $batch; }

    $where = $clauses ? 'WHERE ' . implode(' AND ', $clauses) : '';
    $rows = query(DIARY_SELECT . " $where ORDER BY d.date DESC, d.id DESC", $params);
    $entries = array_map(function ($r) { $r['slots'] = json_decode($r['slots'], true); return $r; }, $rows);
    json_response(['entries' => $entries]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $date = $body['date'] ?? null;
    $slots = $body['slots'] ?? null;
    if (!$date) error_response('date is required');
    if (!is_array($slots)) error_response('slots must be an array');

    $info = run('
        INSERT INTO diary_entries (instructor_id, course_id, date, week, month, batch, slots, instructor_remarks, to_remarks, to_signature)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ', [
        $me['id'], $body['course_id'] ?? null, $date, $body['week'] ?? '', $body['month'] ?? '', $body['batch'] ?? null,
        json_encode(clean_diary_slots($slots)), $body['instructor_remarks'] ?? '', $body['to_remarks'] ?? '', $body['to_signature'] ?? '',
    ]);

    $entry = query(DIARY_SELECT . ' WHERE d.id = ?', [$info['lastInsertRowid']])[0];
    $entry['slots'] = json_decode($entry['slots'], true);
    json_response(['entry' => $entry], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $entry = query('SELECT * FROM diary_entries WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$entry) error_response('Entry not found', 404);

    $body = request_body();
    $date = $body['date'] ?? null;
    $slots = $body['slots'] ?? null;
    if (!$date) error_response('date is required');
    if (!is_array($slots)) error_response('slots must be an array');

    run('
        UPDATE diary_entries SET course_id = ?, date = ?, week = ?, month = ?, batch = ?, slots = ?, instructor_remarks = ?, to_remarks = ?, to_signature = ?
        WHERE id = ?
    ', [
        $body['course_id'] ?? null, $date, $body['week'] ?? '', $body['month'] ?? '', $body['batch'] ?? null,
        json_encode(clean_diary_slots($slots)), $body['instructor_remarks'] ?? '', $body['to_remarks'] ?? '', $body['to_signature'] ?? '',
        $entry['id'],
    ]);

    $updated = query(DIARY_SELECT . ' WHERE d.id = ?', [$entry['id']])[0];
    $updated['slots'] = json_decode($updated['slots'], true);
    json_response(['entry' => $updated]);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $info = run('DELETE FROM diary_entries WHERE id = ?', [$segments[0]]);
    if ($info['changes'] === 0) error_response('Entry not found', 404);
    json_response(['message' => 'Diary entry deleted']);
}

error_response('Not found', 404);
