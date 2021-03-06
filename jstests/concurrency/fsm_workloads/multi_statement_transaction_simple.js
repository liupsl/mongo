'use strict';

/**
 * Creates several bank accounts. On each iteration, each thread:
 *  - chooses two accounts and amount of money being transfer
 *  - or checks the balance of each account
 * @tags: [uses_transactions]
 */
var $config = (function() {

    function _calcTotalMoneyBalances(sessionDb, txnNumber, collName) {
        let res = sessionDb.runCommand({
            find: collName,
            batchSize: 0,
            filter: {},
            readConcern: {level: "snapshot"},
            txnNumber: NumberLong(txnNumber),
            startTransaction: true,
            autocommit: false
        });
        assertWhenOwnColl.commandWorked(res);
        let cursorId = res.cursor.id;

        let total = 0;
        while (bsonWoCompare({_: cursorId}, {_: 0}) !== 0) {
            res = sessionDb.runCommand({
                getMore: cursorId,
                collection: collName,
                txnNumber: NumberLong(txnNumber),
                autocommit: false
            });
            assertWhenOwnColl.commandWorked(res);
            res.cursor.nextBatch.forEach(function(account) {
                total += account.balance;
            });
            cursorId = res.cursor.id;
        }
        // commitTransaction can only be called on the admin database.
        assertWhenOwnColl.commandWorked(sessionDb.adminCommand(
            {commitTransaction: 1, txnNumber: NumberLong(txnNumber), autocommit: false}));
        return total;
    }

    var states = (function() {

        function init(db, collName) {
            const session = db.getMongo().startSession({causalConsistency: false});
            this.sessionDb = session.getDatabase(db.getName());
            this.txnNumber = 0;
        }

        function checkMoneyBalance(db, collName) {
            this.txnNumber++;
            assertWhenOwnColl.eq(_calcTotalMoneyBalances(this.sessionDb, this.txnNumber, collName),
                                 this.numAccounts * this.initialValue);
        }

        function transferMoney(db, collName) {
            const transferFrom = Random.randInt(this.numAccounts);
            let transferTo = Random.randInt(this.numAccounts);
            while (transferFrom === transferTo) {
                transferTo = Random.randInt(this.numAccounts);
            }
            const transferAmount = Random.randInt(this.initialValue / 10);
            const commands = [
                {
                  update: collName,
                  updates: [{q: {_id: transferFrom}, u: {$inc: {balance: -transferAmount}}}],
                  readConcern: {level: "snapshot"},
                  startTransaction: true,
                  autocommit: false
                },
                {
                  update: collName,
                  updates: [{q: {_id: transferTo}, u: {$inc: {balance: transferAmount}}}],
                  autocommit: false
                },
                {commitTransaction: 1, autocommit: false}
            ];

            let hasWriteConflict;
            do {
                this.txnNumber++;
                hasWriteConflict = false;
                for (let cmd of commands) {
                    cmd["txnNumber"] = NumberLong(this.txnNumber);
                    let res;
                    if (cmd.hasOwnProperty("commitTransaction")) {
                        res = this.sessionDb.adminCommand(cmd);
                    } else {
                        res = this.sessionDb.runCommand(cmd);
                    }
                    if (res.ok === 0) {
                        if (res.code === ErrorCodes.WriteConflict) {
                            hasWriteConflict = true;
                            break;
                        } else {
                            assertWhenOwnColl.commandWorked(res, () => tojson(cmd));
                        }
                    }
                }
            } while (hasWriteConflict);
        }

        return {init: init, transferMoney: transferMoney, checkMoneyBalance: checkMoneyBalance};
    })();

    function setup(db, collName) {
        assertWhenOwnColl.commandWorked(db.runCommand({create: collName}));
        for (let i = 0; i < this.numAccounts; ++i) {
            const res = db[collName].insert({_id: i, balance: this.initialValue});
            assertWhenOwnColl.writeOK(res);
            assertWhenOwnColl.eq(1, res.nInserted);
        }
    }

    function teardown(db, collName, cluster) {
        const session = db.getMongo().startSession({causalConsistency: false});
        assertWhenOwnColl.eq(
            _calcTotalMoneyBalances(session.getDatabase(db.getName()), NumberLong(0), collName),
            this.numAccounts * this.initialValue);
    }

    var transitions = {
        init: {transferMoney: 1},
        transferMoney: {transferMoney: 0.9, checkMoneyBalance: 0.1},
        checkMoneyBalance: {transferMoney: 1}
    };

    var skip = function skip(cluster) {
        if (cluster.isSharded() || cluster.isStandalone()) {
            return {skip: true, msg: 'only runs in a replica set.'};
        }
        return {skip: false};
    };

    return {
        threadCount: 4,
        iterations: 20,
        startState: 'init',
        states: states,
        transitions: transitions,
        data: {numAccounts: 20, initialValue: 2000},
        setup: setup,
        skip: skip,
        teardown: teardown
    };

})();
