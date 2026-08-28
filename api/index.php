<?php

require __DIR__ . '/lib/bootstrap.php';

$method = $_SERVER['REQUEST_METHOD'];

// PHP doesn't populate $_FILES/$_POST for native PUT/PATCH requests, so the
// frontend sends those as POST with a _method field when a file is attached.
// See public/js/app.js's api() helper.
if ($method === 'POST' && isset($_POST['_method'])) {
    $method = strtoupper($_POST['_method']);
}

$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$apiPos = strpos($uri, '/api/');
$path = $apiPos === false ? '' : substr($uri, $apiPos + strlen('/api/'));
$segments = array_values(array_filter(explode('/', trim($path, '/')), fn($s) => $s !== ''));
$resource = array_shift($segments) ?? '';

$routeFile = __DIR__ . "/routes/$resource.php";
if ($resource === '' || !ctype_alpha($resource) || !is_file($routeFile)) {
    error_response('Not found', 404);
}

try {
    require $routeFile;
} catch (UploadException $e) {
    error_response($e->getMessage(), 400);
} catch (Throwable $e) {
    error_log($e);
    error_response('Internal server error', 500);
}
