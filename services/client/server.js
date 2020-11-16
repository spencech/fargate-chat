// Setup basic express server
var _ = require('lodash');
var crypto = require('crypto');
var express = require('express');
var compression = require('compression');
var path = require('path');
var enforce = require('express-sslify');
var config = require('./lib/config');

var app = express();

// GZIP compress resources served
app.use(compression());

// Force redirect to HTTPS if the protocol was HTTP
if (!process.env.LOCAL) {
  app.use(enforce.HTTPS({ trustProtoHeader: true }));
}

var server = require('http').createServer(app);
var io = require('socket.io')(server);
var redis = require('socket.io-redis');
io.adapter(redis({ host: config.REDIS_ENDPOINT, port: 6379 }));

var Presence = require('./lib/presence');
var User = require('./lib/user');
var Message = require('./lib/message');

// Lower the heartbeat timeout (helps us expire disconnected people faster)
io.set('heartbeat timeout', config.HEARTBEAT_TIMEOUT);
io.set('heartbeat interval', config.HEARTBEAT_INTERVAL);

// Routing
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', function(socket) {
  // Initially the socket starts out as not authenticated
  socket.authenticated = false;

  Presence.list(function(users) {
    // Tell the socket how many users are present.
    io.to(socket.id).emit('presence', {
      numUsers: users.length
    });
  });

  socket.on("session-update", async function(data, callback) {
    if (!socket.authenticated) {
      // Don't allow people not authenticated to send a message
      return callback('Can\'t send a message until you are authenticated');
    }

    if (!data.room || !_.isString(data.room)) {
      return callback('Must pass a parameter `room` which is a string');
    }

    if (!data.game || !_.isString(data.game)) {
      return callback('Must pass a parameter `game` which is a string');
    }

    var messageBody = {
      room: data.room,
      time: Date.now(),
      type: "session-update",
      content: {
        game: data.game
      },
      username: socket.username,
      avatar: socket.avatar
    };

    // Store the messages in DynamoDB
    messageBody.message = await Message.add(messageBody);

    socket.broadcast.emit(data.room, messageBody);

    return callback(null, messageBody);
  })

  socket.on("student-response", async function(data, callback) {
    if (!socket.authenticated) {
      // Don't allow people not authenticated to send a message
      return callback('Can\'t send a message until you are authenticated');
    }

    if (!data.room || !_.isString(data.room)) {
      return callback('Must pass a parameter `room` which is a string');
    }

    if (!data.response || !_.isString(data.response)) {
      return callback('Must pass a parameter `response` which is a string');
    }

    var messageBody = {
      room: data.room,
      time: Date.now(),
      type: "student-response",
      content: {
        response: data.response
      },
      username: socket.username,
      avatar: socket.avatar
    };

    // Store the messages in DynamoDB
    messageBody.message = await Message.add(messageBody);

    socket.broadcast.emit(data.room, messageBody);

    return callback(null, messageBody);
  });

  socket.on("mousemove", async function(data, callback) {
    if (!socket.authenticated) {
      // Don't allow people not authenticated to send a message
      return callback('Can\'t send a message until you are authenticated');
    }

    if (!data.room || !_.isString(data.room)) {
      return callback('Must pass a parameter `room` which is a string');
    }

    if (!data.position || !_.isString(data.position)) {
      return callback('Must pass a parameter `position` which is a string');
    }

    var messageBody = {
      room: data.room,
      time: Date.now(),
      type: "mousemove",
      content: {
        position: data.position
      },
      username: socket.username,
      avatar: socket.avatar
    };

    // Store the messages in DynamoDB ---
    messageBody.message = await Message.add(messageBody);

    socket.broadcast.emit(data.room, messageBody);

    return callback(null, messageBody);
  });

  socket.conn.on('heartbeat', function() {
    if (!socket.authenticated) {
      // Don't start counting as present until they authenticate.
      return;
    }

    Presence.upsert(socket.id, {
      username: socket.username,
      room: socket.room
    });
  });
  
  socket.on('join-session', function(data, callback) {
    
    if (!_.isFunction(callback)) {
      return;
    }

    if (!data.room || !_.isString(data.room)) {
      return callback('Must pass a parameter `room` which is a string');
    }

    if (!data.role || !_.isString(data.role)) {
      return callback('Must pass a parameter `role` which is a string');
    }

    if (!data.id) {
      return callback('Must pass a parameter `id` which is an integer');
    }

    socket.authenticated = true;
    socket.username = data.role + '_' + data.id  +  '_' + crypto.randomBytes(3).toString('hex');
    socket.avatar = 'https://www.gravatar.com/avatar/' + crypto.createHash('md5').update(socket.username).digest('hex') + '?d=retro';
    socket.room = data.room;
    // Set the user as present.
    Presence.upsert(socket.id, {
      username: socket.username,
      room: socket.room
    });
    socket.present = true;

    Presence.listInRoom(data.room, function(users) {

      socket.emit(data.room, {
        numUsers: users.length,
        id: data.id,
        role: data.role,
        users: users,
        from: "socket.emit",
        type: "user-joined-session"
      });
      
      socket.broadcast.emit(data.room, {
        numUsers: users.length,
        id: data.id,
        role: data.role,
        users: users,
        from: "socket.broadcast",
        type: "user-joined-session"
      });
    
    });

    return callback(null, {
      username: socket.username,
      avatar: socket.avatar
    });
  });

  // when the user disconnects.. perform this
  socket.on('disconnect', function() {
    if (socket.authenticated) {
      
      Presence.remove(socket.id);

      Presence.listInRoom(socket.room, function(users) {
        socket.broadcast.emit(socket.room, {
          username: socket.username,
          avatar: socket.avatar,
          users: users,
          numUsers: users.length,
          type: "user-disconnected"
        });
      });
    }
  });
});

module.exports = server;
