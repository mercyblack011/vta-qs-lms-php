<?php
// Mirrors src/routes/courses.js. $method and $segments are set by api/index.php.

function issue_certificate_if_needed(int $userId, int $courseId): array {
    $existing = query('SELECT * FROM certificates WHERE user_id = ? AND course_id = ?', [$userId, $courseId]);
    if ($existing) return $existing[0];
    $code = 'VTA-QS-' . strtoupper(bin2hex(random_bytes(4)));
    $info = run('INSERT INTO certificates (user_id, course_id, cert_code) VALUES (?, ?, ?)', [$userId, $courseId, $code]);
    return query('SELECT * FROM certificates WHERE id = ?', [$info['lastInsertRowid']])[0];
}

function clean_module_list($list): array {
    if (is_string($list)) {
        $decoded = json_decode($list, true);
        $list = is_array($decoded) ? $decoded : [];
    }
    if (!is_array($list)) return [];
    $out = [];
    foreach ($list as $m) {
        $module = trim(is_array($m) ? ($m['module'] ?? '') : '');
        $code = trim(is_array($m) ? ($m['code'] ?? '') : '');
        if ($module || $code) $out[] = ['module' => $module, 'code' => $code];
    }
    return $out;
}

function course_fields_from_body(array $body, array $existing = []): array {
    $studyMode = in_array($body['study_mode'] ?? null, ['Full Time', 'Part Time'], true) ? $body['study_mode'] : 'Full Time';
    $qualificationType = in_array($body['qualification_type'] ?? null, ['NVQ-05', 'Non-NVQ'], true) ? $body['qualification_type'] : 'NVQ-05';
    $isNvq = $qualificationType === 'NVQ-05';
    $duration = isset($body['duration']) && $body['duration'] !== '' ? (int) $body['duration'] : null;

    return [
        'name' => trim($body['name'] ?? ''),
        'description' => array_key_exists('description', $body) ? $body['description'] : ($existing['description'] ?? ''),
        'icon' => $body['icon'] ?? ($existing['icon'] ?? 'fa-book-open'),
        'duration' => $duration !== null ? $duration : ($existing['duration'] ?? null),
        'studyMode' => $studyMode,
        'qualificationType' => $qualificationType,
        'sem1Modules' => $isNvq ? json_encode(clean_module_list($body['sem1_modules'] ?? null)) : null,
        'sem2Modules' => $isNvq ? json_encode(clean_module_list($body['sem2_modules'] ?? null)) : null,
        'modules' => $isNvq ? null : json_encode(clean_module_list($body['modules'] ?? null)),
        'instructor' => $body['instructor'] ?? '',
    ];
}

// GET / - catalogue with enrollment/progress info for the current user if logged in
if ($method === 'GET' && $segments === []) {
    $courses = query('SELECT * FROM courses ORDER BY id');
    $me = current_user_or_null();
    $enrollMap = [];
    if ($me) {
        foreach (query('SELECT course_id, progress FROM enrollments WHERE user_id = ?', [$me['id']]) as $r) {
            $enrollMap[$r['course_id']] = $r['progress'];
        }
    }
    $result = array_map(function ($c) use ($enrollMap) {
        $c['enrolled'] = array_key_exists($c['id'], $enrollMap);
        $c['progress'] = $enrollMap[$c['id']] ?? 0;
        return $c;
    }, $courses);
    json_response(['courses' => $result]);
}

if ($method === 'POST' && $segments === []) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $file = handle_upload('logo', 'courses', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    $body = request_body();
    if (empty($body['name'])) { if ($file) delete_uploaded_file($file['path']); error_response('name is required'); }
    $f = course_fields_from_body($body);
    $logoUrl = $file ? $file['path'] : null;

    $info = run(
        'INSERT INTO courses (name, description, icon, duration, logo_url, study_mode, qualification_type, sem1_modules, sem2_modules, modules, instructor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [$f['name'], $f['description'], $f['icon'], $f['duration'], $logoUrl, $f['studyMode'], $f['qualificationType'], $f['sem1Modules'], $f['sem2Modules'], $f['modules'], $f['instructor']]
    );
    $course = query('SELECT * FROM courses WHERE id = ?', [$info['lastInsertRowid']])[0];
    json_response(['course' => $course], 201);
}

if ($method === 'PUT' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $courseId = (int) $segments[0];
    $existing = query('SELECT * FROM courses WHERE id = ?', [$courseId])[0] ?? null;
    $file = handle_upload('logo', 'courses', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    if (!$existing) { if ($file) delete_uploaded_file($file['path']); error_response('Course not found', 404); }
    $body = request_body();
    if (empty($body['name'])) { if ($file) delete_uploaded_file($file['path']); error_response('name is required'); }
    $f = course_fields_from_body($body, $existing);
    $logoUrl = $file ? $file['path'] : $existing['logo_url'];

    run(
        'UPDATE courses SET name = ?, description = ?, icon = ?, duration = ?, logo_url = ?, study_mode = ?, qualification_type = ?,
          sem1_modules = ?, sem2_modules = ?, modules = ?, instructor = ? WHERE id = ?',
        [$f['name'], $f['description'], $f['icon'], $f['duration'], $logoUrl, $f['studyMode'], $f['qualificationType'], $f['sem1Modules'], $f['sem2Modules'], $f['modules'], $f['instructor'], $courseId]
    );
    if ($file && $existing['logo_url']) delete_uploaded_file($existing['logo_url']);
    $course = query('SELECT * FROM courses WHERE id = ?', [$courseId])[0];
    json_response(['course' => $course]);
}

if ($method === 'DELETE' && count($segments) === 1 && ctype_digit($segments[0])) {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $courseId = (int) $segments[0];
    $existing = query('SELECT * FROM courses WHERE id = ?', [$courseId])[0] ?? null;
    if (!$existing) error_response('Course not found', 404);
    run('DELETE FROM courses WHERE id = ?', [$courseId]);
    if ($existing['logo_url']) delete_uploaded_file($existing['logo_url']);
    json_response(['message' => 'Course removed']);
}

if ($method === 'GET' && $segments === ['mine']) {
    $me = require_auth();
    $rows = query('
        SELECT c.*, e.progress FROM enrollments e JOIN courses c ON c.id = e.course_id
        WHERE e.user_id = ? ORDER BY e.enrolled_at DESC
    ', [$me['id']]);
    json_response(['courses' => $rows]);
}

// Aggregate counts only (no student/lecturer PII) - safe for any authenticated role.
if ($method === 'GET' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'summary') {
    $me = require_auth();
    $courseId = (int) $segments[0];
    $sql = '
        SELECT COUNT(DISTINCT s.id) AS n FROM students s
        JOIN enrollments e ON e.user_id = s.user_id
        WHERE e.course_id = ?
    ';
    $params = [$courseId];
    if ($me['role'] === 'student') {
        $myStudent = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        if ($myStudent) { $sql .= ' AND s.batch = ?'; $params[] = $myStudent['batch']; }
    }
    $studentCount = query($sql, $params)[0]['n'];
    $lecturerCount = query('SELECT COUNT(*) AS n FROM lecturers WHERE course_id = ?', [$courseId])[0]['n'];
    json_response(['studentCount' => (int) $studentCount, 'lecturerCount' => (int) $lecturerCount]);
}

// Name + modules only (no lecturer_id/photo/email) - safe for any authenticated role.
if ($method === 'GET' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'lecturers') {
    require_auth();
    $rows = query('SELECT name, modules FROM lecturers WHERE course_id = ?', [(int) $segments[0]]);
    json_response(['lecturers' => $rows]);
}

// id + name + batch + MIS number + photo only (no NIC) - safe for classmates to see each other.
if ($method === 'GET' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'students') {
    $me = require_auth();
    $rows = query('
        SELECT s.id, s.name, s.batch, s.mis_no, s.photo_url, s.user_id FROM students s
        JOIN enrollments e ON e.user_id = s.user_id
        WHERE e.course_id = ?
        ORDER BY s.name
    ', [(int) $segments[0]]);

    $visible = $rows;
    if ($me['role'] === 'student') {
        $caller = query('SELECT batch FROM students WHERE user_id = ?', [$me['id']])[0] ?? null;
        if ($caller) $visible = array_values(array_filter($rows, fn($s) => $s['batch'] === $caller['batch']));
    }

    $result = array_map(function ($s) use ($me) {
        $isMe = $s['user_id'] == $me['id'];
        unset($s['user_id']);
        $s['is_me'] = $isMe;
        return $s;
    }, $visible);
    json_response(['students' => array_values($result)]);
}

if ($method === 'POST' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'enroll') {
    $me = require_auth();
    require_role($me, 'instructor', 'admin');
    $courseId = (int) $segments[0];
    $course = query('SELECT * FROM courses WHERE id = ?', [$courseId])[0] ?? null;
    if (!$course) error_response('Course not found', 404);

    $existing = query('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId]);
    if ($existing) error_response('Already enrolled in this course', 409);

    run('INSERT INTO enrollments (user_id, course_id, progress) VALUES (?, ?, 0)', [$me['id'], $courseId]);
    json_response(['message' => "Enrolled in {$course['name']}"], 201);
}

if ($method === 'POST' && count($segments) === 2 && ctype_digit($segments[0]) && $segments[1] === 'progress') {
    $me = require_auth();
    $courseId = (int) $segments[0];
    $body = request_body();
    $progress = $body['progress'] ?? null;
    if (!is_numeric($progress) || $progress < 0 || $progress > 100) {
        error_response('progress must be a number between 0 and 100');
    }
    $enrollment = query('SELECT * FROM enrollments WHERE user_id = ? AND course_id = ?', [$me['id'], $courseId])[0] ?? null;
    if (!$enrollment) error_response('Not enrolled in this course', 404);

    $clamped = min(100, max((int) $enrollment['progress'], (int) $progress));
    run('UPDATE enrollments SET progress = ? WHERE id = ?', [$clamped, $enrollment['id']]);

    $certificate = null;
    if ($clamped >= 100) {
        $certificate = issue_certificate_if_needed($me['id'], $courseId);
    }
    json_response(['progress' => $clamped, 'certificate' => $certificate]);
}

error_response('Not found', 404);
