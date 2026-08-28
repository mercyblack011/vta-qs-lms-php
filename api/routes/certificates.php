<?php
// Mirrors src/routes/certificates.js. $method and $segments are set by api/index.php.

if ($method === 'GET' && $segments === ['mine']) {
    $me = require_auth();
    $rows = query('
        SELECT cert.*, c.name AS course_name, u.name AS student_name
        FROM certificates cert
        JOIN courses c ON c.id = cert.course_id
        JOIN users u ON u.id = cert.user_id
        WHERE cert.user_id = ?
        ORDER BY cert.issued_at DESC
    ', [$me['id']]);
    json_response(['certificates' => $rows]);
}

// Public verification endpoint - anyone with a certificate code can confirm it's genuine.
if ($method === 'GET' && count($segments) === 2 && $segments[0] === 'verify') {
    $rows = query('
        SELECT cert.*, c.name AS course_name, u.name AS student_name
        FROM certificates cert
        JOIN courses c ON c.id = cert.course_id
        JOIN users u ON u.id = cert.user_id
        WHERE cert.cert_code = ?
    ', [$segments[1]]);
    if (!$rows) json_response(['valid' => false, 'error' => 'Certificate not found'], 404);
    json_response(['valid' => true, 'certificate' => $rows[0]]);
}

error_response('Not found', 404);
