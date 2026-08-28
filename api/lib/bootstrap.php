<?php

require __DIR__ . '/response.php';
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/upload.php';

session_set_cookie_params(['httponly' => true, 'samesite' => 'Lax']);
session_start();
