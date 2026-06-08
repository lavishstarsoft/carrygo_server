const { getSupabaseAdmin } = require('./supabase');

const connectDB = async () => {
    try {
        const supabase = getSupabaseAdmin();
        const { error } = await supabase.from('users').select('id').limit(1);
        if (error) {
            throw new Error(error.message);
        }
        console.log('Supabase Connected');
    } catch (error) {
        console.error(`Error connecting to Supabase: ${error.message}`);
        process.exit(1);
    }
};

module.exports = connectDB;
