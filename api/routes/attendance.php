<?php
// Mirrors src/routes/attendance.js. $method and $segments are set by api/index.php.

function today_date_str(): string {
    return date('Y-m-d');
}

if ($method === 'GET' && $segments === ['mine']) {
    $me = require_auth();
    $month = $_GET['month'] ?? '';
    if (!preg_match('/^\d{4}-\d{2}$/', $month)) error_response('month query param required, format YYYY-MM');
    $student = query('SELECT id FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
    if (!$student) json_response(['attendance' => []]);
    [$year, $mon] = array_map('intval', explode('-', $month));
    $rows = query('SELECT date, status FROM attendance WHERE student_id = ? AND YEAR(date) = ? AND MONTH(date) = ?', [$student['id'], $year, $mon]);
    json_response(['attendance' => $rows]);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin', 'student');
    $month = $_GET['month'] ?? '';
    if (!preg_match('/^\d{4}-\d{2}$/', $month)) error_response('month query param required, format YYYY-MM');
    [$year, $mon] = array_map('intval', explode('-', $month));

    if ($me['role'] === 'student') {
        $enrollment = query('SELECT course_id FROM enrollments WHERE user_id = ? ORDER BY enrolled_at DESC LIMIT 1', [$me['id']])[0] ?? null;
        if (!$enrollment) json_response(['attendance' => []]);
        $rows = query('
            SELECT a.student_id, a.date, a.status FROM attendance a
            JOIN students s ON s.id = a.student_id
            JOIN enrollments e ON e.user_id = s.user_id
            WHERE e.course_id = ? AND YEAR(a.date) = ? AND MONTH(a.date) = ?
        ', [$enrollment['course_id'], $year, $mon]);
        json_response(['attendance' => $rows]);
    }

    $rows = query('SELECT student_id, date, status FROM attendance WHERE YEAR(date) = ? AND MONTH(date) = ?', [$year, $mon]);
    json_response(['attendance' => $rows]);
}

if ($method === 'PUT' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $studentId = $body['student_id'] ?? null;
    $date = $body['date'] ?? null;
    $status = array_key_exists('status', $body) ? $body['status'] : null;
    if (!$studentId || !$date || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
        error_response('student_id and date (YYYY-MM-DD) are required');
    }
    if ($date > today_date_str()) error_response('Cannot mark attendance for a future date');

    if ($status === null || $status === '') {
        run('DELETE FROM attendance WHERE student_id = ? AND date = ?', [$studentId, $date]);
        json_response(['student_id' => $studentId, 'date' => $date, 'status' => null]);
    }
    if (!in_array($status, ['P', 'A', 'L'], true)) error_response('status must be P, A, L or null');

    run('
        INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by)
    ', [$studentId, $date, $status, $me['id']]);
    json_response(['student_id' => $studentId, 'date' => $date, 'status' => $status]);
}

if ($method === 'POST' && $segments === ['mark-all-present']) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $month = $body['month'] ?? '';
    if (!preg_match('/^\d{4}-\d{2}$/', $month)) error_response('month is required, format YYYY-MM');
    if ($month >= substr(today_date_str(), 0, 7)) {
        error_response('Cannot mark the whole current or a future month present - only past months');
    }

    [$year, $mon] = array_map('intval', explode('-', $month));
    $daysInMonth = (int) date('t', mktime(0, 0, 0, $mon, 1, $year));
    $students = query('SELECT id FROM students');

    $pdo = db();
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("INSERT IGNORE INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, 'P', ?)");
        foreach ($students as $s) {
            for ($d = 1; $d <= $daysInMonth; $d++) {
                $dow = (int) date('w', mktime(0, 0, 0, $mon, $d, $year));
                if ($dow === 0 || $dow === 6) continue; // skip weekends
                $date = sprintf('%s-%02d', $month, $d);
                if ($date > today_date_str()) continue; // never mark future dates
                $stmt->execute([$s['id'], $date, $me['id']]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    json_response(['message' => 'Marked all weekdays present where not already marked']);
}

if ($method === 'POST' && $segments === ['mark-day']) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $date = $body['date'] ?? null;
    $status = $body['status'] ?? null;
    if (!$date || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) error_response('date (YYYY-MM-DD) is required');
    if (!in_array($status, ['P', 'A', 'L'], true)) error_response('status must be P, A or L');
    if ($date > today_date_str()) error_response('Cannot mark attendance for a future date');

    $students = query('SELECT id FROM students');
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare('
            INSERT INTO attendance (student_id, date, status, marked_by) VALUES (?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE status = VALUES(status), marked_by = VALUES(marked_by)
        ');
        foreach ($students as $s) {
            $stmt->execute([$s['id'], $date, $status, $me['id']]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    json_response(['message' => "Marked all students as $status for $date"]);
}

error_response('Not found', 404);
