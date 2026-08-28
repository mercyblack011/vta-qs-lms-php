<?php
// Mirrors src/routes/students.js. $method and $segments are set by api/index.php.

const STUDENT_SELECT = "
  SELECT s.*,
    (SELECT c.name FROM enrollments e JOIN courses c ON c.id = e.course_id
     WHERE e.user_id = s.user_id ORDER BY e.enrolled_at DESC, e.id DESC LIMIT 1) AS course_name,
    (SELECT e.course_id FROM enrollments e
     WHERE e.user_id = s.user_id ORDER BY e.enrolled_at DESC, e.id DESC LIMIT 1) AS course_id
  FROM students s
";

if ($method === 'GET' && $segments === ['batches']) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $rows = query("SELECT DISTINCT batch FROM students WHERE batch IS NOT NULL AND batch <> ''");
    $values = array_column($rows, 'batch');
    $numeric = array_values(array_filter($values, fn($b) => is_numeric($b)));
    usort($numeric, fn($a, $b) => $b - $a);
    $nonNumeric = array_values(array_filter($values, fn($b) => !is_numeric($b)));
    sort($nonNumeric);
    $batches = array_merge($numeric, $nonNumeric);
    json_response(['batches' => $batches, 'latest' => $batches[0] ?? null]);
}

if ($method === 'GET' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $courseId = $_GET['course_id'] ?? null;
    $batch = $_GET['batch'] ?? null;
    $rows = query(STUDENT_SELECT . ' ORDER BY s.id DESC');

    if ($me['role'] === 'instructor') {
        $myCourses = query('SELECT DISTINCT course_id FROM lecturers WHERE user_id = ? AND course_id IS NOT NULL', [$me['id']]);
        $myCourseIds = array_column($myCourses, 'course_id');
        $rows = array_values(array_filter($rows, fn($s) => in_array($s['course_id'], $myCourseIds)));
    }
    if ($courseId) $rows = array_values(array_filter($rows, fn($s) => (string) $s['course_id'] === (string) $courseId));
    if ($batch) $rows = array_values(array_filter($rows, fn($s) => stripos($s['batch'] ?? '', $batch) !== false));

    json_response(['students' => $rows]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'admin');
    $file = handle_upload('photo', 'students', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    $body = request_body();
    $name = trim($body['name'] ?? '');
    $email = trim($body['email'] ?? '');
    $password = $body['password'] ?? '';
    $courseId = $body['course_id'] ?? null;
    $nic = $body['nic'] ?? null;
    $batch = $body['batch'] ?? null;
    $misNo = $body['mis_no'] ?? null;

    if (!$name || !$email || !$password || !$courseId) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('name, email, password and course_id are required');
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
    if (!query('SELECT id FROM courses WHERE id = ?', [$courseId])) {
        if ($file) delete_uploaded_file($file['path']);
        error_response('Selected course not found', 404);
    }

    $hash = password_hash($password, PASSWORD_BCRYPT);
    $userId = run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [$name, $cleanEmail, $hash, 'student'])['lastInsertRowid'];

    $photoUrl = $file ? $file['path'] : null;
    $studentId = run('INSERT INTO students (user_id, name, nic, batch, mis_no, photo_url) VALUES (?, ?, ?, ?, ?, ?)',
        [$userId, $name, $nic ?: null, $batch ?: 'NVQ-5', $misNo ?: null, $photoUrl])['lastInsertRowid'];

    run('INSERT INTO enrollments (user_id, course_id, progress) VALUES (?, ?, 0)', [$userId, $courseId]);

    $student = query(STUDENT_SELECT . ' WHERE s.id = ?', [$studentId])[0];
    json_response(['student' => $student], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $student = query('SELECT * FROM students WHERE id = ?', [$segments[0]])[0] ?? null;
    $file = handle_upload('photo', 'students', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    if (!$student) { if ($file) delete_uploaded_file($file['path']); error_response('Student not found', 404); }

    $body = request_body();
    $courseId = $body['course_id'] ?? null;
    if ($courseId) {
        if (!$student['user_id']) {
            if ($file) delete_uploaded_file($file['path']);
            error_response('This student has no linked login account to enroll.');
        }
        if (!query('SELECT id FROM courses WHERE id = ?', [$courseId])) {
            if ($file) delete_uploaded_file($file['path']);
            error_response('Selected course not found', 404);
        }
        run('INSERT INTO enrollments (user_id, course_id, progress) VALUES (?, ?, 0)
             ON DUPLICATE KEY UPDATE enrolled_at = NOW()', [$student['user_id'], $courseId]);
    }

    $photoUrl = $file ? $file['path'] : $student['photo_url'];
    run('UPDATE students SET name = ?, nic = ?, batch = ?, mis_no = ?, photo_url = ? WHERE id = ?', [
        $body['name'] ?? $student['name'], $body['nic'] ?? $student['nic'], $body['batch'] ?? $student['batch'],
        $body['mis_no'] ?? $student['mis_no'], $photoUrl, $student['id'],
    ]);
    $updated = query(STUDENT_SELECT . ' WHERE s.id = ?', [$student['id']])[0];
    json_response(['student' => $updated]);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'admin');
    $info = run('DELETE FROM students WHERE id = ?', [$segments[0]]);
    if ($info['changes'] === 0) error_response('Student not found', 404);
    json_response(['message' => 'Student removed']);
}

error_response('Not found', 404);
