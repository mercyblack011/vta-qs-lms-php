<?php
// Mirrors src/routes/admin.js. $method and $segments are set by api/index.php.

if ($method === 'GET' && $segments === ['stats']) {
    $me = require_auth();
    require_role($me, 'admin');
    $totalStudents = query('SELECT COUNT(*) AS n FROM students')[0]['n'];
    json_response(['totalStudents' => (int) $totalStudents]);
}

error_response('Not found', 404);
