<?php
// Mirrors src/routes/auth.js. $method and $segments are set by api/index.php.

if ($method === 'POST' && $segments === ['login']) {
    $body = request_body();
    $email = trim($body['email'] ?? '');
    $password = $body['password'] ?? '';
    if (!$email || !$password) error_response('email and password are required');

    $rows = query('SELECT * FROM users WHERE email = ?', [strtolower($email)]);
    $user = $rows[0] ?? null;
    if (!$user || !password_verify($password, $user['password_hash'])) {
        error_response('Invalid email or password', 401);
    }

    login_session($user);
    json_response(['user' => public_user($user)]);
}

// Not present in the Node app (stateless JWT had nothing server-side to invalidate) -
// added because PHP sessions do: the frontend calls this from doLogout().
if ($method === 'POST' && $segments === ['logout']) {
    logout_session();
    json_response(['message' => 'Logged out']);
}

if ($method === 'GET' && $segments === ['me']) {
    $me = require_auth();
    $rows = query('SELECT * FROM users WHERE id = ?', [$me['id']]);
    if (!$rows) error_response('User not found', 404);
    json_response(['user' => public_user($rows[0])]);
}

if ($method === 'GET' && $segments === ['profile']) {
    $me = require_auth();
    $rows = query('SELECT * FROM users WHERE id = ?', [$me['id']]);
    if (!$rows) error_response('User not found', 404);
    $user = $rows[0];
    $result = public_user($user);

    if ($user['role'] === 'student') {
        $rows = query("
            SELECT s.mis_no, s.nic, s.batch, s.photo_url,
              (SELECT c.name FROM enrollments e JOIN courses c ON c.id = e.course_id
               WHERE e.user_id = s.user_id ORDER BY e.enrolled_at DESC, e.id DESC LIMIT 1) AS course_name
            FROM students s WHERE s.user_id = ?
        ", [$user['id']]);
        $result['studentProfile'] = $rows[0] ?? null;
    } elseif ($user['role'] === 'instructor') {
        $result['lecturerProfiles'] = query("
            SELECT l.lecturer_id, l.modules, l.photo_url, c.name AS course_name
            FROM lecturers l LEFT JOIN courses c ON c.id = l.course_id WHERE l.user_id = ?
        ", [$user['id']]);
    }
    json_response(['user' => $result]);
}

if ($method === 'PUT' && $segments === ['profile']) {
    $me = require_auth();
    $file = handle_upload('photo', 'students', IMAGE_TYPES, 3 * 1024 * 1024, 'JPEG, PNG, WEBP or GIF images');
    $rows = query('SELECT * FROM users WHERE id = ?', [$me['id']]);
    if (!$rows) { if ($file) delete_uploaded_file($file['path']); error_response('User not found', 404); }
    $user = $rows[0];

    $newName = trim(request_body()['name'] ?? '');
    if (!$newName) { if ($file) delete_uploaded_file($file['path']); error_response('Name is required'); }

    run('UPDATE users SET name = ? WHERE id = ?', [$newName, $user['id']]);

    $table = $user['role'] === 'student' ? 'students' : ($user['role'] === 'instructor' ? 'lecturers' : null);
    if ($table) {
        if ($file) {
            $old = query("SELECT photo_url FROM $table WHERE user_id = ? LIMIT 1", [$user['id']])[0] ?? null;
            run("UPDATE $table SET name = ?, photo_url = ? WHERE user_id = ?", [$newName, $file['path'], $user['id']]);
            if ($old && $old['photo_url']) delete_uploaded_file($old['photo_url']);
        } else {
            run("UPDATE $table SET name = ? WHERE user_id = ?", [$newName, $user['id']]);
        }
    }

    $updated = query('SELECT * FROM users WHERE id = ?', [$user['id']])[0];
    json_response(['user' => public_user($updated)]);
}

if ($method === 'PUT' && $segments === ['password']) {
    $me = require_auth();
    $body = request_body();
    $current = $body['current_password'] ?? '';
    $new = $body['new_password'] ?? '';
    if (!$current || !$new) error_response('current_password and new_password are required');
    if (strlen($new) < 4) error_response('New password must be at least 4 characters');

    $user = query('SELECT * FROM users WHERE id = ?', [$me['id']])[0] ?? null;
    if (!$user || !password_verify($current, $user['password_hash'])) {
        error_response('Current password is incorrect', 401);
    }

    run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($new, PASSWORD_BCRYPT), $user['id']]);
    json_response(['message' => 'Password updated successfully']);
}

error_response('Not found', 404);
