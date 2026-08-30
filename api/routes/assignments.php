<?php
// Mirrors src/routes/assignments.js. $method and $segments are set by api/index.php.

function assignment_lecturer_covers_module(?array $lecturerRow, array $assignment): bool {
    if (!$lecturerRow) return false;
    if (!$assignment['module']) return true;
    $modules = json_decode($lecturerRow['modules'] ?? '[]', true) ?: [];
    foreach ($modules as $m) if (($m['module'] ?? null) === $assignment['module']) return true;
    return false;
}

function can_manage_assignment_sync(array $user, array $assignment, ?array $lecturerRow): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    if ($assignment['instructor_id'] == $user['id']) return true;
    return assignment_lecturer_covers_module($lecturerRow, $assignment);
}

function can_manage_assignment(array $user, array $assignment): bool {
    if ($user['role'] === 'admin') return true;
    if ($user['role'] !== 'instructor') return false;
    if ($assignment['instructor_id'] == $user['id']) return true;
    $lecturer = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$user['id'], $assignment['course_id']])[0] ?? null;
    return assignment_lecturer_covers_module($lecturer, $assignment);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    $courseId = $_GET['course_id'] ?? null;
    $module = $_GET['module'] ?? null;
    $batch = $_GET['batch'] ?? null;
    $clauses = [];
    $params = [];
    if ($courseId) { $clauses[] = 'a.course_id = ?'; $params[] = $courseId; }
    if ($module) { $clauses[] = 'a.module = ?'; $params[] = $module; }
    if ($batch) { $clauses[] = 'a.batch = ?'; $params[] = $batch; }
    $where = $clauses ? 'WHERE ' . implode(' AND ', $clauses) : '';

    $rows = query("
        SELECT a.*, c.name AS course_name,
          (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
        FROM assignments a
        LEFT JOIN courses c ON c.id = a.course_id
        $where
        ORDER BY a.created_at DESC
    ", $params);

    $myLecturerRows = [];
    if ($me['role'] === 'instructor') {
        $myLecturerRows = query('SELECT course_id, modules FROM lecturers WHERE user_id = ?', [$me['id']]);
        $rows = array_values(array_filter($rows, function ($a) use ($me, $myLecturerRows) {
            if ($a['instructor_id'] == $me['id']) return true;
            $lecturerRow = null;
            foreach ($myLecturerRows as $l) if ($l['course_id'] == $a['course_id']) { $lecturerRow = $l; break; }
            return assignment_lecturer_covers_module($lecturerRow, $a);
        }));
    }
    foreach ($rows as &$a) {
        $lecturerRow = null;
        foreach ($myLecturerRows as $l) if ($l['course_id'] == $a['course_id']) { $lecturerRow = $l; break; }
        $a['can_edit_deadline'] = can_manage_assignment_sync($me, $a, $lecturerRow);
    }
    unset($a);

    if ($me['role'] === 'student') {
        $myStudent = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        if ($myStudent) $rows = array_values(array_filter($rows, fn($a) => !$a['batch'] || $a['batch'] === $myStudent['batch']));

        $mySubs = query('SELECT assignment_id, grade, feedback, submitted_at, file_path, file_name FROM submissions WHERE student_user_id = ?', [$me['id']]);
        $subMap = [];
        foreach ($mySubs as $s) $subMap[$s['assignment_id']] = $s;
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
    json_response(['assignments' => array_values($rows)]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $file = handle_upload('file', 'assignments', ['application/pdf'], 15 * 1024 * 1024, 'PDF files');
    $body = request_body();
    $title = trim($body['title'] ?? '');
    if (!$title) { if ($file) delete_uploaded_file($file['path']); error_response('title is required'); }

    $courseId = $body['course_id'] ?? null;
    $module = $body['module'] ?? null;
    if ($me['role'] === 'instructor') {
        $lecturerRow = query('SELECT * FROM lecturers WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId ?: null])[0] ?? null;
        if (!assignment_lecturer_covers_module($lecturerRow, ['module' => $module ?: null])) {
            if ($file) delete_uploaded_file($file['path']);
            error_response('You can only create assignments for a course and module you are assigned to teach.', 403);
        }
    }

    $info = run(
        'INSERT INTO assignments (title, course_id, module, instructor_id, start_at, end_at, instructions, file_path, file_name, batch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$title, $courseId ?: null, $module ?: null, $me['id'], $body['start_at'] ?? null, $body['end_at'] ?? null,
         $body['instructions'] ?? '', $file ? $file['path'] : null, $file ? $file['name'] : null, $body['batch'] ?? null]
    );
    $assignment = query('SELECT * FROM assignments WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['assignment' => $assignment], 201);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $assignment = query('SELECT * FROM assignments WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$assignment) error_response('Assignment not found', 404);
    if (!can_manage_assignment($me, $assignment)) {
        error_response('You can only delete assignments for a course and module you are assigned to teach.', 403);
    }
    $subFiles = query('SELECT file_path FROM submissions WHERE assignment_id = ?', [$assignment['id']]);
    run('DELETE FROM assignments WHERE id = ?', [$assignment['id']]);
    if ($assignment['file_path']) delete_uploaded_file($assignment['file_path']);
    foreach ($subFiles as $s) delete_uploaded_file($s['file_path']);
    json_response(['message' => 'Assignment removed']);
}

if ($method === 'PUT' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'deadline') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $assignment = query('SELECT * FROM assignments WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$assignment) error_response('Assignment not found', 404);
    $endAt = request_body()['end_at'] ?? null;
    if (!$endAt) error_response('end_at is required');

    if (!can_manage_assignment($me, $assignment)) {
        error_response("You are not permitted to change this assignment's deadline", 403);
    }
    run('UPDATE assignments SET end_at = ? WHERE id = ?', [$endAt, $assignment['id']]);
    $updated = query('SELECT * FROM assignments WHERE id = ?', [$assignment['id']])[0];
    json_response(['assignment' => $updated]);
}

if ($method === 'POST' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'submit') {
    $me = require_auth();
    require_role($me, 'student');
    $assignment = query('SELECT * FROM assignments WHERE id = ?', [$segments[0]])[0] ?? null;
    $file = handle_upload('file', 'submissions', DOC_TYPES, 15 * 1024 * 1024, 'PDF, JPEG, PNG, WEBP or GIF files');
    if (!$assignment) { if ($file) delete_uploaded_file($file['path']); error_response('Assignment not found', 404); }

    if ($assignment['end_at'] && time() > strtotime($assignment['end_at'])) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('The deadline for this assignment has passed. Submissions are closed.', 403);
    }
    if (!$file) error_response('Please attach a PDF or image of your work');

    $note = request_body()['note'] ?? '';
    run('
        INSERT INTO submissions (assignment_id, student_user_id, note, file_path, file_name, submitted_at)
        VALUES (?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE note = VALUES(note), file_path = VALUES(file_path), file_name = VALUES(file_name),
          submitted_at = NOW(), grade = NULL, feedback = NULL
    ', [$assignment['id'], $me['id'], $note, $file['path'], $file['name']]);

    json_response(['message' => 'Submission recorded'], 201);
}

if ($method === 'GET' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'submissions') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $assignment = query('SELECT a.*, c.name AS course_name FROM assignments a LEFT JOIN courses c ON c.id = a.course_id WHERE a.id = ?', [$segments[0]])[0] ?? null;
    if (!$assignment) error_response('Assignment not found', 404);
    if (!can_manage_assignment($me, $assignment)) {
        error_response('You can only view submissions for a course and module you are assigned to teach.', 403);
    }

    $rows = query('
        SELECT s.*, u.name AS student_name FROM submissions s
        JOIN users u ON u.id = s.student_user_id
        WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC
    ', [$segments[0]]);
    json_response(['assignment' => $assignment, 'submissions' => $rows]);
}

if ($method === 'PUT' && count($segments) === 4 && ctype_digit($segments[0]) && $segments[1] === 'submissions' && ctype_digit($segments[2]) && $segments[3] === 'grade') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $assignment = query('SELECT * FROM assignments WHERE id = ?', [$segments[0]])[0] ?? null;
    if (!$assignment) error_response('Assignment not found', 404);
    if (!can_manage_assignment($me, $assignment)) {
        error_response('You can only grade submissions for a course and module you are assigned to teach.', 403);
    }

    $body = request_body();
    $info = run('UPDATE submissions SET grade = ?, feedback = ? WHERE id = ? AND assignment_id = ?',
        [$body['grade'] ?? null, $body['feedback'] ?? null, $segments[2], $segments[0]]);
    if ($info['changes'] === 0) error_response('Submission not found', 404);
    json_response(['message' => 'Grade saved']);
}

error_response('Not found', 404);
