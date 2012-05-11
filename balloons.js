
/*
 * Module dependencies
 */

var express = require('express')
  , sio = require('socket.io')
  , easyoauth = require('easy-oauth')
  , redis = require('redis')
  , RedisStore = require('connect-redis')(express)
  , config = require('./config.json')
  , utils = require('./utils');

/*
 * Instantiate redis
 */

var client = redis.createClient();

/*
 * Create and config server
 */

var app = express.createServer();

app.configure(function() {
    app.set('view engine', 'jade'); 
    app.set('views', __dirname + '/views/themes/' + config.theme.name);
    app.use(express.static(__dirname + '/public'));
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.session({
        secret: config.session.secret,
        store: new RedisStore
    }));
    app.use(easyoauth(config.auth));
    app.use(app.router);
});

/*
 * Routes
 */

app.get('/', function(req, res, next) {
    req.authenticate(['oauth'], function(error, authenticated) { 
        if(authenticated) {
            client.hmset('users:' + req.getAuthDetails().user.username, req.getAuthDetails().user);
            res.redirect('/rooms/list');
        } else {
            res.render('index');
        } 
    });
});

app.get('/rooms/list', utils.restrict, function(req, res) {
    client.smembers('balloons:public:rooms', function(err, rooms) {
        res.locals({
            rooms: rooms
        });
        res.render('room_list');
    });
});

app.post('/create', utils.restrict, function(req, res) {
    if(req.body.room_name.length <= 30) {
        client.hgetall('rooms:' + req.body.room_name + ':info', function(err1, room) {
            if(Object.keys(room).length) {
                res.redirect( '/rooms/' + room.name );

            } else {
                var room = {
                    name: encodeURIComponent(req.body.room_name),
                    admin: req.getAuthDetails().user.username,
                    locked: 0
                };

                client.hmset('rooms:' + req.body.room_name + ':info', room, function(err2, id) {
                    if(!err2) {
                        res.redirect('/rooms/' + encodeURIComponent(req.body.room_name));
                        client.sadd('balloons:public:rooms', req.body.room_name);
                    }
                });
            }
        });
    } else {
        res.redirect('back');
    }
});

app.get('/rooms/:id', utils.restrict, function(req, res) {
    client.hgetall('rooms:' + req.params.id + ':info', function(err1, room) {
    	if(Object.keys(room).length) {
            client.smembers('rooms:' + req.params.id + ':online', function(err2, online_users) {
                var users = []
                  , user_status = 'available';

                online_users.forEach(function(username, index) {
                    client.get('users:' + username + ':status', function(err4, status) {
                        if(req.getAuthDetails().user.username == username) {
                            user_status = status || 'available';
                        }
                        users.push({
                            username: username,
                            status: status || 'available'
                        });
                    });
                });

                client.smembers("balloons:public:rooms", function(err3, rooms) {

                    res.locals({
                        rooms: rooms,
                        room_name: room.name,
                        room_id: req.params.id,
                        username: req.getAuthDetails().user.username,
                        user_status: user_status,
                        users_list: users
                    });

                    res.render('room');
                });
            });
    	} else {
    		res.redirect('back');
    	}
    });
});

/*
 * Socket.io
 */


var io = sio.listen(app);

io.configure(function() {
	io.set('store', new sio.RedisStore);
	io.enable('browser client minification');
	io.enable('browser client gzip');
});


io.sockets.on('connection', function (socket) {
	socket.on('set nickname', function(data) {
        var nickname = data.nickname
           , room_id = data.room_id;

        socket.join(room_id);

        socket.set('nickname', nickname, function () {
            socket.set('room_id', room_id, function () {

                client.sadd('users:' + nickname + ':sockets', socket.id, function(err1, socketAdded) {
                    if(socketAdded) {
                        console.log("socketID#", socket.id, "successfuly added to", nickname, "\'s sockets list!!");

                        client.sadd('rooms:' + room_id + ':online', nickname, function(err2, userAdded) {
                            if(userAdded) {
                                client.get('users:' + nickname + ':status', function(err, status) {
                                    io.sockets.in(data.room_id).emit('new user', {
                                        nickname: nickname,
                                        status: status || 'available'
                                    });
                                });
                            }
                        });
                    }
                });
            });
		});
	});

	socket.on('my msg', function(data) {
		socket.get('nickname', function(err1, nickname) {
			socket.get('room_id', function(err2, room_id) {	
				var no_empty = data.msg.replace("\n","");
				if(no_empty.length > 0) {
                    io.sockets.in(room_id).emit('new msg', {
                        nickname: nickname,
                        msg: data.msg
                    });        
                }	
			});
		});
	});

    socket.on('set status', function(data) {
        var status = data.status;

        socket.get('nickname', function(err1, nickname) {

            client.set('users:' + nickname + ':status', status, function(err1, statusSet) {
                console.info(nickname, 'has setted', status);
                io.sockets.emit('user-info update', {
                    username: nickname,
                    status: status
                });
            });
        });
    });

    socket.on('disconnect', function() {

        socket.get('room_id', function(err1, room_id) {
            socket.get('nickname', function(err2, nickname) {
                // 'sockets:at:' + room_id + ':for:' + nickname
                client.srem('users:' + nickname + ':sockets', socket.id, function(err3, removed) {
                    if(removed) {
                        console.info('socket#' + socket.id + ' successfuly removed from ' + nickname + '\'s sockets list!');
                        
                        client.scard('users:' + nickname + ':sockets', function(err4, members_no) {
                            if(!members_no) {
                                client.srem('rooms:' + room_id + ':online', nickname, function(err5, removed) {
                                    if (removed) {
                                        io.sockets.in(room_id).emit('user leave', {
                                            nickname: nickname
                                        });
                                    }
                                });
                            }
                        });
                    }
                });

            });
        });

    });
});


app.listen(3000);

console.log('Balloons.io started at port %d', app.address().port);