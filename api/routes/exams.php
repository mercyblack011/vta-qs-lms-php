<?php
// Mirrors src/routes/exams.js. $method and $segments are set by api/index.php.

function exam_lecturer_covers_module(?array $lecturerRow, array $exam): bool {
    if (!$lecturerRow) return false;
    if (!$exam['module']) return true;
    $modules = json_decode($lecturerRow['modules'] ?? '[]', true) ?: [];
    foreach ($modules as $m) if (($m['module'] ?? null) === $exam['module']) return true;
    return false;
}

function can_manage_exam_sync(array $user, array $exam, ?array $lecturerRow): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    if ($exam['instructor_id'] == $user['id']) return true;
    return exam_lecturer_covers_module($lecturerRow, $exam);
}

function can_manage_exam(array $user, array $exam): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    if ($exam['instructor_id'] == $user['id']) return true;
    $lecturer = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$user['id'], $exam['course_id']])[0] ?? null;
    return exam_lecturer_covers_module($lecturer, $exam);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    $courseId = $_GET['course_id'] ?? null;
    $module = $_GET['module'] ?? null;
    $batch = $_GET['batch'] ?? null;
    $clauses = [];
    $params = [];
    if ($courseId) { $clauses[] = 'e.course_id = ?'; $params[] = $courseId; }
    if ($module) { $clauses[] = 'e.module = ?'; $params[] = $module; }
    if ($batch) { $clauses[] = 'e.batch = ?'; $params[] = $batch; }
    $where = $clauses ? 'WHERE ' . implode(' AND ', $clauses) : '';

    $rows = query("
        SELECT e.*, c.name AS course_name,
          (SELECT COUNT(*) FROM exam_submissions s WHERE s.exam_id = e.id) AS submission_count
        FROM exams e
        LEFT JOIN courses c ON c.id = e.course_id
        $where
        ORDER BY e.created_at DESC
    ", $params);

    $myLecturerRows = [];
    if ($me['role'] === 'instructor') {
        $myLecturerRows = query('SELECT course_id, modules FROM lecturers WHERE user_id = ?', [$me['id']]);
        $rows = array_values(array_filter($rows, function ($e) use ($me, $myLecturerRows) {
            if ($e['instructor_id'] == $me['id']) return true;
            $lecturerRow = null;
            foreach ($myLecturerRows as $l) if ($l['course_id'] == $e['course_id']) { $lecturerRow = $l; break; }
            return exam_lecturer_covers_module($lecturerRow, $e);
        }));
    }
    foreach ($rows as &$e) {
        $lecturerRow = null;
        foreach ($myLecturerRows as $l) if ($l['course_id'] == $e['course_id']) { $lecturerRow = $l; break; }
        $e['can_edit_deadline'] = can_manage_exam_sync($me, $e, $lecturerRow);
    }
    unset($e);

    if ($me['role'] === 'student') {
        $myStudent = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        if ($myStudent) $rows = array_values(array_filter($rows, fn($e) => !$e['batch'] || $e['batch'] === $myStudent['batch']));

        $mySubs = query('SELECT exam_id, grade, feedback, submitted_at, file_path, file_name FROM exam_submissions WHERE student_user_id = ?', [$me['id']]);
        $subMap = [];
        foreach ($mySubs as $s) $subMap[$s['exam_id']] = $s;
        foreach ($rows as &$r) {
            $sub = $subMap[$r['id']] ?? null;
            $r['my_submission'] = (bool) $sub;
            $r['my_grade'] = $sub['grade'] ?? null;
            $r['my_feedback'] = $sub['feedback'] ?? null;
            $r['my_submission_file'] = $sub['file_path'] ?? null;
            $r['my_submission_file_name'] = $sub['file_name'] ?? null;
        }
        unset($r);
    }
    json_response(['exams' => array_values($rows)]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $body = request_body();
    $title = trim($body['title'] ?? '');
    if (!$title) error_response('title is required');

    $courseId = $body['course_id'] ?? null;
    $module = $body['module'] ?? null;
    if ($me['role'] === 'instructor') {
        $lecturerRow = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId ?: null])[0] ?? null;
        if (!exam_lecturer_covers_module($lecturerRow, ['module' => $module ?: null])) {
            error_response('You can only open an exam portal for a course and module you are assigned to teach.', 403);
        }
    }

    $info = run('INSERT INTO exams (title, course_id, module, instructor_id, start_at, end_at, batch) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [$title, $courseId ?: null, $module ?: null, $me['id'], $body['start_at'] ?? null, $body['end_at'] ?? null, $body['batch'] ?? null]);
    $exam = query('SELECT * FROM exams WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['exam' => $exam], 201);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $exam = query('SELECT * FROM exams WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$exam) error_response('Exam not found', 404);
    if (!can_manage_exam($me, $exam)) {
        error_response('You can only delete exams for a course and module you are assigned to teach.', 403);
    }
    $subFiles = query('SELECT file_path FROM exam_submissions WHERE exam_id = ?', [$exam['id']]);
    run('DELETE FROM exams WHERE id = ?', [$exam['id']]);
    foreach ($subFiles as $s) delete_uploaded_file($s['file_path']);
    json_response(['message' => 'Exam removed']);
}

if ($method === 'PUT' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'deadline') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $exam = query('SELECT * FROM exams WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$exam) error_response('Exam not found', 404);
    $endAt = request_body()['end_at'] ?? null;
    if (!$endAt) error_response('end_at is required');

    if (!can_manage_exam($me, $exam)) {
        error_response("You are not permitted to change this exam's deadline", 403);
    }
    run('UPDATE exams SET end_at = ? WHERE id = ?', [$endAt, $exam['id']]);
    $updated = query('SELECT * FROM exams WHERE id = ?', [$exam['id']])[0];
    json_response(['exam' => $updated]);
}

if ($method === 'POST' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'submit') {
    $me = require_auth();
    require_role($me, 'student');
    $exam = query('SELECT * FROM exams WHERE id = ?', [$segments[0]])[0] ?? null;
    $file = handle_upload('file', 'exam-submissions', DOC_TYPES, 15 * 1024 * 1024, 'PDF, JPEG, PNG, WEBP or GIF files');
    if (!$exam) { if ($file) delete_uploaded_file($file['path']); error_response('Exam not found', 404); }

    if ($exam['end_at'] && time() > strtotime($exam['end_at'])) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('The submission window for this exam has closed.', 403);
    }
    if (!$file) error_response('Please attach a photo or PDF of your exam paper');

    run('
        INSERT INTO exam_submissions (exam_id, student_user_id, file_path, file_name, submitted_at)
        VALUES (?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE file_path = VALUES(file_path), file_name = VALUES(file_name),
          submitted_at = NOW(), grade = NULL, feedback = NULL
    ', [$exam['id'], $me['id'], $file['path'], $file['name']]);

    json_response(['message' => 'Exam paper submitted'], 201);
}

if ($method === 'GET' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'submissions') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $exam = query('SELECT e.*, c.name AS course_name FROM exams e LEFT JOIN courses c ON c.id = e.course_id WHERE e.id = ?', [$segments[0]])[0] ?? null;
    if (!$exam) error_response('Exam not found', 404);
    if (!can_manage_exam($me, $exam)) {
        error_response('You can only view submissions for a course and module you are assigned to teach.', 403);
    }

    $rows = query('
        SELECT s.*, u.name AS student_name FROM exam_submissions s
        JOIN users u ON u.id = s.student_user_id
        WHERE s.exam_id = ? ORDER BY s.submitted_at DESC
    ', [$segments[0]]);
    json_response(['exam' => $exam, 'submissions' => $rows]);
}

if ($method === 'PUT' && count($segments) === 4 && ctype_digit($segments[0]) && $segments[1] === 'submissions' && ctype_digit($segments[2]) && $segments[3] === 'grade') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $exam = query('SELECT * FROM exams WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$exam) error_response('Exam not found', 404);
    if (!can_manage_exam($me, $exam)) {
        error_response('You can only grade submissions for a course and module you are assigned to teach.', 403);
    }

    $body = request_body();
    $info = run('UPDATE exam_submissions SET grade = ?, feedback = ? WHERE id = ? AND exam_id = ?',
        [$body['grade'] ?? null, $body['feedback'] ?? null, $segments[2], $segments[0]]);
    if ($info['changes'] === 0) error_response('Submission not found', 404);
    json_response(['message' => 'Grade saved']);
}

error_response('Not found', 404);
