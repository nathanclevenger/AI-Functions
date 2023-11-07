import { BSON, ObjectId } from 'bson'
import { AIDB } from '../db/mongo'
import PQueue from 'p-queue'
import { chatCompletion, CompletionInput } from '../utils/completion'
import { createMachine, createActor } from 'xstate'
import { ChangeStreamInsertDocument, InsertOneResult, UpdateOneModel, UpdateResult } from 'mongodb'

let localQueue

export type QueueConfig = AIDB & {
  batchSize?: number
  concurrency?: number
  lockExpiration?: number
}

export type QueueInputMerge = {
  into: string
  on?: BSON.Document
  let?: BSON.Document
  contentAs?: string
  itemsAs?: string
  functionDataAs?: string
  forEachItem?: boolean
}
export type QueueInput = (CompletionInput | ({ list: string } & Partial<CompletionInput>)) & {
  _id?: ObjectId
  metadata?: object
  merge?: string | QueueInputMerge
  target?: string
}

export type QueueDocument = QueueInput & {
  lockedAt: Date
  lockedBy: string
}

export const startQueue = async (config: QueueConfig) => {

  const { concurrency = 10, batchSize = 100, lockExpiration = 3600, ...db } = config
  const instance = Math.random().toString(36).substring(2, 6)
  const queue = new PQueue({ concurrency })

  const clearExpiredLocks = () => db.queue.updateMany(
    { lockedAt: { $lt: new Date(Date.now() - lockExpiration * 1000) } },
    { $unset: { lockedAt: '', lockedBy: '' } }
  )

  const lockBatch = () => db.queue.aggregate([
    { $match: { lockedAt: { $exists: false } } },
    { $limit: batchSize },
    { $set: { lockedAt: new Date(), lockedBy: instance } },
    { $merge: { into: 'queue', on: '_id', whenMatched: 'replace' } }, // TODO: Change the `into` to the name of the `queue` collection
  ]).toArray()

  db.queue.watch<QueueInput, ChangeStreamInsertDocument< QueueInput >>([
    { $match: { lockedBy: instance } },
  ]).on('change', async (change) => {
    const { _id, metadata, merge, target, ...input } = change.fullDocument // TODO: Move input to child object not catchall spread
    const completion = await queue.add(() => chatCompletion(input))
    if (merge) {
      const coll = typeof merge === 'string' ? merge : merge.into 
      const match = typeof merge === 'string' ? undefined : merge.on
      // TODO: Add support to make completion optional, and specify field names for content, items, and functionData
      const mergeResult = match 
        ? await db.db.collection(coll).updateOne(match, { $set: { completion, ...metadata ?? {} } })
        : await db.db.collection(coll).insertOne({ completion, ...metadata ?? {} })
      if (mergeResult.acknowledged && (
          (mergeResult as UpdateResult).modifiedCount ||
          (mergeResult as InsertOneResult).insertedId)) {
        // TODO: We may want to store the merge result in the Events collection to link the queue input to the merge result
        await db.queue.deleteOne({ _id })
      }
    }
  })

  queue.on('idle', async () => {
    await clearExpiredLocks()
    await lockBatch()
  })

  queue.start()

  // TODO: Add Find() and Watch() for Actors collection
  // TODO: For each actor, create a state machine and start it
  // TODO: Figure out how to create new queued jobs from the results of the state machine

}

