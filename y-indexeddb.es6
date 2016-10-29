(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/* global Y */
'use strict'
// Thx to @jed for this script https://gist.github.com/jed/982883
function generateGuid(a){return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,generateGuid)} // eslint-disable-line

function extend (Y) {
  Y.requestModules(['memory']).then(function () {
    class Store {
      constructor (transaction, name) {
        this.store = transaction.objectStore(name)
      }
      * find (id) {
        return yield this.store.get(id)
      }
      * put (v) {
        yield this.store.put(v)
      }
      * delete (id) {
        yield this.store.delete(id)
      }
      * findWithLowerBound (start) {
        return yield this.store.openCursor(window.IDBKeyRange.lowerBound(start))
      }
      * findWithUpperBound (end) {
        return yield this.store.openCursor(window.IDBKeyRange.upperBound(end), 'prev')
      }
      * findNext (id) {
        return yield* this.findWithLowerBound([id[0], id[1] + 1])
      }
      * findPrev (id) {
        return yield* this.findWithUpperBound([id[0], id[1] - 1])
      }
      * iterate (t, start, end, gen) {
        var range = null
        if (start != null && end != null) {
          range = window.IDBKeyRange.bound(start, end)
        } else if (start != null) {
          range = window.IDBKeyRange.lowerBound(start)
        } else if (end != null) {
          range = window.IDBKeyRange.upperBound(end)
        }
        var cursorResult
        if (range != null) {
          cursorResult = this.store.openCursor(range)
        } else {
          cursorResult = this.store.openCursor()
        }
        while ((yield cursorResult) != null) {
          yield* gen.call(t, cursorResult.result.value)
          cursorResult.result.continue()
        }
      }
      * flush () {}
    }

    function createStoreClone (Store) {
      class Clone extends Store {
        constructor () {
          super(...arguments)
          this.buffer = []
          this._copyTo = null
        }
        // copy to this store
        // it may be neccessary to reset this every time you create a transaction
        copyTo (store) {
          this._copyTo = store
          return this
        }
        * put (v, dontCopy) {
          if (!dontCopy) {
            this.buffer.push(this._copyTo.put(v))
          }
          yield* super.put(v)
        }
        * delete (id) {
          this.buffer.push(this._copyTo.delete(id))
          yield* super.delete(id)
        }
        * flush () {
          yield* super.flush()
          for (var i = 0; i < this.buffer.length; i++) {
            yield* this.buffer[i]
          }
          yield* this._copyTo.flush()
        }
      }
      return Clone
    }
    Y.utils.createStoreClone = createStoreClone

    var BufferedStore = Y.utils.createSmallLookupBuffer(Store)
    var ClonedStore = Y.utils.createStoreClone(Y.utils.RBTree)

    class Transaction extends Y.Transaction {
      constructor (store) {
        super(store)
        var transaction = store.db.transaction(['OperationStore', 'StateStore', 'DeleteStore'], 'readwrite')
        this.store = store
        this.ss = new BufferedStore(transaction, 'StateStore')
        this.os = new BufferedStore(transaction, 'OperationStore')
        this._ds = new BufferedStore(transaction, 'DeleteStore')
        this.ds = store.dsClone.copyTo(this._ds)
      }
    }
    class OperationStore extends Y.AbstractDatabase {
      constructor (y, options) {
        super(y, options)
        // dsClone is persistent over transactions!
        // _ds is not
        this.dsClone = new ClonedStore()

        if (options == null) {
          options = {}
        }
        this.options = options
        if (options.namespace == null) {
          if (y.options.connector.room == null) {
            throw new Error('IndexedDB: expect a string (options.namespace)! (you can also skip this step if your connector has a room property)')
          } else {
            options.namespace = y.options.connector.room
          }
        }
        if (options.idbVersion != null) {
          this.idbVersion = options.idbVersion
        } else {
          this.idbVersion = 5
        }
        var store = this
        // initialize database!
        this.requestTransaction(function * () {
          store.db = yield window.indexedDB.open(options.namespace, store.idbVersion)
        })
        if (options.cleanStart) {
          delete window.localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])]
          this.requestTransaction(function * () {
            yield this.os.store.clear()
            yield this._ds.store.clear()
            yield this.ss.store.clear()
          })
        }
        this.whenUserIdSet(function (userid) {
          if (window.localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])] == null) {
            window.localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])] = JSON.stringify([userid, 0])
          }
        })
        this.requestTransaction(function * () {
          // this should be executed after the previous two defined transactions
          // after we computed the upgrade event (see `yield indexedDB.open(..)`), we can check if userid is still stored on localstorage
          var uid = window.localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])]
          if (uid != null) {
            store.setUserId(uid)
            var nextuid = JSON.parse(uid)
            nextuid[1] = nextuid[1] + 1
            window.localStorage[JSON.stringify(['Yjs_indexeddb', options.namespace])] = JSON.stringify(nextuid)
          } else {
            // wait for a 200ms before setting a random user id
            window.setTimeout(function () {
              if (store.userId == null) {
                // the user is probably offline, so that the connector can't get a user id
                store.setUserId(generateGuid()) // TODO: maybe it is best to always use a generated uid
              }
            }, 200)
          }
          // copy from persistent Store to not persistent StoreClone. (there could already be content in Store)
          yield* this._ds.iterate(this, null, null, function * (o) {
            yield* this.ds.put(o, true)
          })
        })
        var operationsToAdd = []
        this.communicationObserver = function (op) {
          operationsToAdd.push(op)
          if (operationsToAdd.length === 1) {
            store.requestTransaction(function * () {
              var _toAdd = []
              /*
              There is a special case (see issue y-js/y-indexeddb#2) which we need to handle:
              Assume a user creates a new type (lets say an Array) and then inserts something in it. Assume both operations are in operationsToAdd.
              Since a type is initialized first, it already knows about the insertion, and we no longer need to call .operationAdded.
              If we don't handle this case the type inserts the same operation twice.
              => So wee need to filter out the operations whose parent is also inclduded in operationsToAdd!
              */
              for (var i = 0; i < operationsToAdd.length; i++) {
                var op = operationsToAdd[i]
                if (op.parent == null || operationsToAdd.every(function (p) {
                  return !Y.utils.compareIds(p.id, op.parent)
                })) {
                  _toAdd.push(op)
                }
              }
              operationsToAdd = []

              for (i = 0; i < _toAdd.length; i++) {
                yield* this.store.operationAdded(this, _toAdd[i], true)
              }
            })
          }
        }
        Y.utils.localCommunication.addObserver(this.options.namespace, this.communicationObserver)
      }
      * operationAdded (transaction, op, noAdd) {
        yield* super.operationAdded(transaction, op)
        if (!noAdd) {
          Y.utils.localCommunication.broadcast(this.options.namespace, op)
        }
      }
      transact (makeGen) {
        var transaction = this.db != null ? new Transaction(this) : null
        var store = this

        var gen = makeGen.call(transaction)
        handleTransactions(gen.next())

        function handleTransactions (result) {
          var request = result.value
          if (result.done) {
            makeGen = store.getNextRequest()
            if (makeGen != null) {
              if (transaction == null && store.db != null) {
                transaction = new Transaction(store)
              }
              gen = makeGen.call(transaction)
              handleTransactions(gen.next())
            } // else no transaction in progress!
            return
          }
          // console.log('new request', request.source != null ? request.source.name : null)
          if (request.constructor === window.IDBRequest) {
            request.onsuccess = function () {
              var res = request.result
              if (res != null && res.constructor === window.IDBCursorWithValue) {
                res = res.value
              }
              handleTransactions(gen.next(res))
            }
            request.onerror = function (err) {
              gen.throw(err)
            }
          } else if (request.constructor === window.IDBCursor) {
            request.onsuccess = function () {
              handleTransactions(gen.next(request.result != null ? request.result.value : null))
            }
            request.onerror = function (err) {
              gen.throw(err)
            }
          } else if (request.constructor === window.IDBOpenDBRequest) {
            request.onsuccess = function (event) {
              var db = event.target.result
              handleTransactions(gen.next(db))
            }
            request.onerror = function () {
              gen.throw("Couldn't open IndexedDB database!")
            }
            request.onupgradeneeded = function (event) {
              var db = event.target.result
              delete window.localStorage[JSON.stringify(['Yjs_indexeddb', store.options.namespace])]
              if (db.objectStoreNames.contains('OperationStore')) {
                // delete only if exists (we skip the remaining tests)
                db.deleteObjectStore('OperationStore')
                db.deleteObjectStore('DeleteStore')
                db.deleteObjectStore('StateStore')
              }
              db.createObjectStore('OperationStore', {keyPath: 'id'})
              db.createObjectStore('DeleteStore', {keyPath: 'id'})
              db.createObjectStore('StateStore', {keyPath: 'id'})
            }
          } else {
            gen.throw('You must not yield this type!')
          }
        }
      }
      // TODO: implement "free"..
      * destroy () {
        Y.utils.localCommunication.removeObserver(this.options.namespace, this.communicationObserver)
        this.db.close()
        yield window.indexedDB.deleteDatabase(this.options.namespace)
      }
    }
    if (Y.utils.localCommunication == null) {
      // localCommunication uses localStorage to communicate with all tabs / windows
      // Using pure localStorage does not call the event listener on the tab the event is created on.
      // Using this implementation the event is also called on the tab the event is created on.
      Y.utils.localCommunication = {
        observer: {},
        addObserver: function (room, f) {
          var listener = this.observer[room]
          if (listener == null) {
            listener = []
            this.observer[room] = listener
          }
          listener.push(f)
        },
        removeObserver: function (room, f) {
          this.observer[room] = this.observer[room].filter(function (g) { return f !== g })
        },
        broadcast: function (room, m) {
          window.localStorage.setItem(JSON.stringify(['__YJS__', room]), JSON.stringify(m))
          this.observer[room].map(function (f) {
            f(m)
          })
        }
      }
      window.addEventListener('storage', function (event) {
        var room
        try {
          var parsed = JSON.parse(event.key)
          if (parsed[0] === '__YJS__') {
            room = parsed[1]
          } else {
            return
          }
        } catch (e) { return }
        var listener = Y.utils.localCommunication.observer[room]
        if (listener != null) {
          listener.map(function (f) {
            f(JSON.parse(event.newValue))
          })
        }
      })
    }
    Y.extend('indexeddb', OperationStore)
  })
}

module.exports = extend
if (typeof Y !== 'undefined') {
  extend(Y)
}

},{}]},{},[1])
