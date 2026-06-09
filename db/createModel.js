const { getSupabaseAdmin } = require('../config/supabase');
const { newId, FROM_ROW, TO_ROW } = require('./mappers');

// ─── Document instance (mongoose-like) ───────────────────────────────────────

class Document {
    constructor(table, data, hooks = {}, makeDoc) {
        this._table = table;
        this._hooks = hooks;
        this._makeDoc = makeDoc;
        Object.assign(this, data);
        this._wrapVehicles();
    }

    _wrapVehicles() {
        if (this._table !== 'drivers' || !Array.isArray(this.vehicles)) return;
        const arr = this.vehicles.map((v) => ({ ...v, _id: v._id || v.id || newId() }));
        this.vehicles = Object.assign(arr, {
            id: (vehicleId) => arr.find((v) => String(v._id) === String(vehicleId)) || null,
        });
    }

    get id() { return this._id; }

    toObject() {
        const obj = { ...this };
        delete obj._table;
        delete obj._hooks;
        return obj;
    }

    markModified() { /* no-op for Supabase */ }

    async save() {
        if (this._hooks.preSave) await this._hooks.preSave(this);
        const toRow = TO_ROW[this._table];
        const row = toRow(this.toObject());
        row.updated_at = new Date().toISOString();
        if (!row.id) {
            row.id = newId();
            this._id = row.id;
            row.created_at = row.created_at || new Date().toISOString();
        }
        const supabase = getSupabaseAdmin();
        const { data, error } = await supabase.from(this._table).upsert(row, { onConflict: 'id' }).select().single();
        if (error) throw new Error(`[${this._table}] save: ${error.message}`);
        const fromRow = FROM_ROW[this._table];
        const fresh = fromRow(data);
        Object.keys(this).forEach((k) => { if (!k.startsWith('_')) delete this[k]; });
        Object.assign(this, fresh);
        if (this._hooks.postSave) await this._hooks.postSave(this);
        return this;
    }
}

// vehicles subdoc helper
Document.prototype._vehiclesProxy = function () {
    const self = this;
    return {
        id(vehicleId) {
            const vid = String(vehicleId);
            return (self.vehicles || []).find((v) => String(v._id) === vid) || null;
        },
    };
};

// ─── Query builder ───────────────────────────────────────────────────────────

class Query {
    constructor(table, hooks, opts = {}, makeDoc) {
        this._table = table;
        this._hooks = hooks;
        this._makeDoc = makeDoc;
        this._mongoFilter = opts.filter || {};
        this._sort = opts.sort || null;
        this._skip = opts.skip || 0;
        this._limit = opts.limit || null;
        this._select = opts.select || null;
        this._populates = opts.populates || [];
        this._single = opts.single || false;
        this._lean = opts.lean || false;
    }

    sort(spec) {
        const key = Object.keys(spec)[0];
        const dir = spec[key] === -1 ? false : true;
        const colMap = { createdAt: 'created_at', updatedAt: 'updated_at' };
        this._sort = { column: colMap[key] || key, ascending: dir };
        return this;
    }

    skip(n) { this._skip = n; return this; }
    limit(n) { this._limit = n; return this; }
    lean() { this._lean = true; return this; }

    select(fields) {
        if (typeof fields === 'string') {
            const inc = !fields.startsWith('-');
            const list = fields.replace(/^-/, '').split(' ').filter(Boolean);
            this._select = { include: inc, fields: list };
        }
        return this;
    }

    populate(path, selectFields) {
        this._populates.push({ path, select: selectFields });
        return this;
    }

    buildFilteredQuery(query) {
        const f = this._mongoFilter;
        const colMap = {
            _id: 'id',
            createdAt: 'created_at',
            updatedAt: 'updated_at',
            isActive: 'is_active',
            relatedId: 'related_id',
            onModel: 'on_model',
            isRead: 'is_read',
            delivery_zone: 'delivery_zone_id',
            driver_id: 'driver_id',
            user_id: 'user_id',
        };
        for (const [key, val] of Object.entries(f)) {
            const col = colMap[key] || key;

            if (val && val.$regex) {
                let pattern = val.$regex.source || String(val);
                pattern = pattern.replace(/^\^/, '').replace(/\$$/, '');
                query = query.ilike(col, pattern);
            } else if (val && val.$in) {
                query = query.in(col, val.$in.map(String));
            } else if (val && val.$ne !== undefined) {
                // NULL must count as "not true" for nullable boolean flags
                if (val.$ne === true && ['is_on_trip', 'is_blocked'].includes(col)) {
                    query = query.or(`${col}.eq.false,${col}.is.null`);
                } else {
                    query = query.neq(col, val.$ne);
                }
            } else if (val && val.$gt) {
                query = query.gt(col, val.$gt instanceof Date ? val.$gt.toISOString() : val.$gt);
            } else if (val && val.$gte) {
                query = query.gte(col, val.$gte instanceof Date ? val.$gte.toISOString() : val.$gte);
            } else if (val && val.$lte) {
                query = query.lte(col, val.$lte instanceof Date ? val.$lte.toISOString() : val.$lte);
            } else if (val === null) {
                query = query.is(col, null);
            } else if (key === 'location' && val && val.$nearSphere) {
                continue;
            } else if (key.includes('.')) {
                continue;
            } else {
                query = query.eq(col, val);
            }
        }
        return query;
    }

    async exec() {
        const supabase = getSupabaseAdmin();
        let query = supabase.from(this._table).select('*');

        // Handle vehicles._id filter specially
        if (this._mongoFilter['vehicles._id']) {
            const driverId = this._mongoFilter._id;
            const vehicleId = String(this._mongoFilter['vehicles._id']);
            const { data, error } = await supabase.from(this._table).select('*').eq('id', String(driverId)).single();
            if (error || !data) return this._single ? null : [];
            const fromRow = FROM_ROW[this._table];
            return fromRow(data);
        }

        query = this.buildFilteredQuery(query);

        if (this._sort) query = query.order(this._sort.column, { ascending: this._sort.ascending });
        if (this._skip) query = query.range(this._skip, this._skip + (this._limit || 100) - 1);
        else if (this._limit) query = query.limit(this._limit);

        const { data, error } = await query;
        if (error) throw new Error(`[${this._table}] find: ${error.message}`);

        let docs = (data || []).map((row) => FROM_ROW[this._table](row));

        // Post-filter for $nearSphere-like or complex filters
        if (this._mongoFilter.location && this._mongoFilter.location.$nearSphere) {
            const { coordinates } = this._mongoFilter.location.$nearSphere.$geometry;
            const maxDist = this._mongoFilter.location.$nearSphere.$maxDistance || 10000;
            const [lng, lat] = coordinates;
            docs = docs.filter((d) => {
                const coords = d.location?.coordinates;
                if (!coords) return false;
                const dist = haversineM(lat, lng, coords[1], coords[0]);
                return dist <= maxDist;
            });
        }

        // Populate
        for (const pop of this._populates) {
            docs = await populateDocs(docs, pop);
        }

        // Select projection
        if (this._select) {
            docs = docs.map((d) => projectFields(d, this._select));
        }

        const wrap = (d) => (d && this._makeDoc ? this._makeDoc(d) : d);
        if (this._single) return wrap(docs[0] || null);
        return docs.map(wrap);
    }

    then(resolve, reject) { return this.exec().then(resolve, reject); }
}

async function populateDocs(docs, { path, select }) {
    if (!docs.length) return docs;
    const refTable = path === 'user_id' ? 'users' : path === 'driver_id' ? 'drivers' : path === 'delivery_zone' ? 'delivery_zones' : null;
    if (!refTable) return docs;

    const ids = [...new Set(docs.map((d) => d[path]).filter(Boolean).map(String))];
    if (!ids.length) return docs;

    const supabase = getSupabaseAdmin();
    const { data } = await supabase.from(refTable).select('*').in('id', ids);
    const map = {};
    (data || []).forEach((row) => { map[row.id] = FROM_ROW[refTable](row); });

    return docs.map((d) => {
        const ref = d[path] ? map[String(d[path])] : null;
        if (ref && select) {
            const fields = select.split(' ').filter(Boolean);
            const projected = { _id: ref._id };
            fields.forEach((f) => { if (ref[f] !== undefined) projected[f] = ref[f]; });
            return { ...d, [path]: projected };
        }
        return { ...d, [path]: ref };
    });
}

function projectFields(doc, { include, fields }) {
    if (include) {
        const out = { _id: doc._id };
        fields.forEach((f) => { if (doc[f] !== undefined) out[f] = doc[f]; });
        return out;
    }
    const out = { ...doc };
    fields.forEach((f) => delete out[f]);
    return out;
}

function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Apply Mongo-style update operators ──────────────────────────────────────

function applyOperators(target, update) {
    if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
            const vehicleMatch = k.match(/^vehicles\.\$\.(.+)$/);
            if (vehicleMatch && update._vehicleId && target.vehicles) {
                const veh = target.vehicles.find((x) => String(x._id) === String(update._vehicleId));
                if (veh) veh[vehicleMatch[1]] = v;
            } else {
                setNested(target, k, v);
            }
        }
    }
    if (update.$push) {
        for (const [k, v] of Object.entries(update.$push)) {
            if (!target[k]) target[k] = [];
            const item = typeof v === 'object' && !Array.isArray(v) ? { ...v, _id: v._id || newId() } : v;
            target[k].push(item);
        }
    }
    if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
            target[k] = (target[k] || 0) + v;
        }
    }
    // Apply any plain (non-operator) top-level fields too. This must run even when
    // operators like $inc/$set/$push are present, otherwise mixed updates such as
    // { is_on_trip: false, $inc: { total_deliveries: 1 } } silently drop the plain fields.
    for (const [k, v] of Object.entries(update)) {
        if (k.startsWith('$') || k === '_vehicleId') continue;
        setNested(target, k, v);
    }
    return target;
}

function setNested(obj, path, value) {
    if (!path.includes('.')) { obj[path] = value; return; }
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        if (cur[parts[i]] === undefined) cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

// ─── Model factory ───────────────────────────────────────────────────────────

function createModel(table, hooks = {}) {
    const fromRow = FROM_ROW[table];
    const toRow = TO_ROW[table];

    const makeDoc = (data) => new Document(table, data, hooks, makeDoc);

    const Model = {
        table,

        _makeDoc: makeDoc,

        find(filter = {}) {
            return new Query(table, hooks, { filter }, makeDoc);
        },

        findOne(filter = {}) {
            return new Query(table, hooks, { filter, single: true, limit: 1 }, makeDoc);
        },

        findById(id) {
            return new Query(table, hooks, { filter: { _id: id }, single: true, limit: 1 }, makeDoc);
        },

        async create(data) {
            const id = newId();
            const now = new Date();
            const docData = { ...data, _id: id, createdAt: now, updatedAt: now };
            const draft = makeDoc(docData);
            if (hooks.preSave) await hooks.preSave(draft);
            const row = toRow(draft.toObject());
            row.id = id;
            if (!row.created_at) row.created_at = now.toISOString();
            if (table !== 'otps') row.updated_at = now.toISOString();
            const supabase = getSupabaseAdmin();
            const { data: inserted, error } = await supabase.from(table).insert(row).select().single();
            if (error) throw new Error(`[${table}] create: ${error.message}`);
            const result = fromRow(inserted);
            const doc = makeDoc(result);
            if (hooks.postSave) await hooks.postSave(doc);
            return doc;
        },

        async findByIdAndUpdate(id, update, options = {}) {
            const existing = await Model.findById(id).exec();
            if (!existing) return null;
            const merged = applyOperators(existing.toObject(), update);
            merged._id = id;
            const doc = makeDoc(merged);
            await doc.save();
            return options.new !== false ? doc : existing;
        },

        async findOneAndUpdate(filter, update, options = {}) {
            // Handle vehicles._id positional update
            if (filter['vehicles._id']) {
                const driver = await Model.findById(filter._id).exec();
                if (!driver) return null;
                const vehicleId = String(filter['vehicles._id']);
                const vehicle = (driver.vehicles || []).find((v) => String(v._id) === vehicleId);
                if (!vehicle) return null;
                if (update.$set) {
                    for (const [k, v] of Object.entries(update.$set)) {
                        const m = k.match(/^vehicles\.\$\.(.+)$/);
                        if (m) vehicle[m[1]] = v;
                    }
                }
                const doc = Model._makeDoc(driver);
                await doc.save();
                return doc;
            }

            const doc = await Model.findOne(filter).exec();
            if (!doc && !options.upsert) return null;

            if (!doc && options.upsert) {
                if (filter.phone && table === 'otps') {
                    return Model.create({ ...update, phone: filter.phone });
                }
                if (filter.key && table === 'settings') {
                    return Model.create({ key: filter.key, value: update.value ?? update });
                }
                return Model.create({ ...filter, ...update });
            }

            const merged = applyOperators(doc.toObject(), update);
            const saved = makeDoc(merged);
            await saved.save();
            return options.new !== false ? saved : doc;
        },

        async findByIdAndDelete(id) {
            const existing = await Model.findById(id).exec();
            if (!existing) return null;
            const supabase = getSupabaseAdmin();
            await supabase.from(table).delete().eq('id', String(id));
            return existing;
        },

        async deleteOne(filter) {
            const doc = await Model.findOne(filter).exec();
            if (!doc) return { deletedCount: 0 };
            const supabase = getSupabaseAdmin();
            await supabase.from(table).delete().eq('id', String(doc._id));
            return { deletedCount: 1 };
        },

        async countDocuments(filter = {}) {
            const supabase = getSupabaseAdmin();
            let query = supabase.from(table).select('*', { count: 'exact', head: true });
            for (const [key, val] of Object.entries(filter)) {
                const col = key === '_id' ? 'id' : key;
                if (val && val.$in) query = query.in(col, val.$in.map(String));
                else if (val && val.$regex) query = query.ilike(col, val.$regex.source || String(val));
                else query = query.eq(col, val);
            }
            const { count, error } = await query;
            if (error) throw new Error(`[${table}] count: ${error.message}`);
            return count || 0;
        },

        async updateMany(filter, update) {
            const docs = await Model.find(filter).exec();
            let modified = 0;
            for (const doc of docs) {
                const merged = applyOperators(doc.toObject ? doc.toObject() : { ...doc }, update);
                const saved = makeDoc(merged);
                await saved.save();
                modified++;
            }
            return { modifiedCount: modified };
        },

        async deleteMany(filter) {
            const docs = await Model.find(filter).exec();
            if (!docs.length) return { deletedCount: 0 };
            const supabase = getSupabaseAdmin();
            const ids = docs.map((d) => String(d._id));
            await supabase.from(table).delete().in('id', ids);
            return { deletedCount: ids.length };
        },
    };

    // Constructor for `new Order({...})`
    function ModelConstructor(data = {}) {
        return makeDoc({ ...data, _id: data._id || newId() });
    }
    return Object.assign(ModelConstructor, Model);
}

module.exports = { createModel, Document, Query };
